use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use chrono::{DateTime, NaiveDateTime, SecondsFormat};
use debrid::putio::{Client, File, Transfer};
use serde_json::json;
use url::Url;

use super::{
    CachedStreams, CommonError, Context, Moch, MochError, MochResult, ResolveParams, Resolved,
    helper::{FolderListing, same_filename, walk_folders},
    static_videos::StaticResponse,
    support::{CachedName, Rule, adding_error, build_cached, index_text, quoted, resolve_target, static_or_err},
};
use crate::{
    domain::config::Config,
    domain::extension::is_video,
    domain::models::{CatalogMeta, ItemMeta, Video, VideoStream},
    domain::stream::Stream,
    infrastructure::magnet::magnet_link,
};

const KEY: &str = "putio";
const POLL_RATE: Duration = Duration::from_secs(2);
const MAX_POLLS: u32 = 15;
const DOWNLOADING: &[&str] = &["WAITING", "IN_QUEUE", "PREPARING_DOWNLOAD", "DOWNLOADING", "COMPLETING"];
const PROCESSING: &[&str] = &["WAITING", "IN_QUEUE", "COMPLETING"];
const READY: &[&str] = &["COMPLETED", "SEEDING"];

struct Putio {
    context: Arc<Context>,
    client: Client,
}

pub fn build(context: Arc<Context>) -> Box<dyn Moch> {
    let client = Client::new(context.http.clone());
    Box::new(Putio { context, client })
}

#[async_trait]
impl Moch for Putio {
    async fn cached_streams(
        &self,
        streams: &[Stream],
        api_key: &str,
        _ip: Option<&str>,
    ) -> MochResult<Option<CachedStreams>> {
        let cached = build_cached(api_key, streams, CachedName::Filename, |_, _, _| false);
        Ok(Some(cached))
    }

    async fn catalog(&self, api_key: &str, _catalog_id: &str, config: &Config) -> MochResult<Vec<CatalogMeta>> {
        if config.skip() > 0 {
            return Ok(Vec::new());
        }
        let listing = self.client.list_files(token(api_key), "0").await?;
        Ok(listing
            .files
            .into_iter()
            .map(|file| CatalogMeta { id: format!("{KEY}:{}", file.id), kind: "other".to_owned(), name: file.name })
            .collect())
    }

    async fn item_meta(&self, item_id: &str, api_key: &str, _ip: Option<&str>) -> MochResult<ItemMeta> {
        let info_hash = self.find_info_hash(api_key, item_id).await?;
        let contents = self.folder_contents(api_key, item_id).await?;
        let videos = contents
            .into_iter()
            .enumerate()
            .map(|(index, (name, file))| Video {
                id: format!("{KEY}:{}:{index}", file.id),
                title: name,
                released: released(&file.created_at),
                streams: vec![VideoStream { url: format!("{api_key}/null/null/{}", file.id), behavior_hints: None }],
                ..Video::default()
            })
            .collect();
        Ok(ItemMeta {
            id: format!("{KEY}:{item_id}"),
            kind: "other".to_owned(),
            info_hash,
            videos,
            ..ItemMeta::default()
        })
    }

    async fn resolve(&self, params: &ResolveParams) -> MochResult<Resolved> {
        match self.resolve_inner(params).await {
            Ok(url) => Ok(url),
            Err(error) => static_for_error(&error, params),
        }
    }

    fn to_common_error(&self, error: &MochError) -> Option<CommonError> {
        common_error(error)
    }
}

fn common_error(error: &MochError) -> Option<CommonError> {
    match error {
        MochError::Common(common) => Some(*common),
        _ => None,
    }
}

impl Putio {
    async fn find_info_hash(&self, api_key: &str, file_id: &str) -> MochResult<Option<String>> {
        let transfers = self.client.list_transfers(token(api_key)).await?;
        Ok(transfers
            .iter()
            .find(|transfer| transfer.file_id.is_some_and(|id| id.to_string() == file_id))
            .and_then(|transfer| decode_info_hash(&transfer.source)))
    }

    async fn folder_contents(&self, api_key: &str, item_id: &str) -> MochResult<Vec<(String, File)>> {
        let client = &self.client;
        let token = token(api_key);
        let contents = walk_folders(item_id, |folder_id: String| async move {
            let entries = client.list_files(token, &folder_id).await?.into_entries();
            let folders =
                entries.iter().filter(|file| file.is_folder()).map(|file| (file.id.to_string(), file.name.clone()));
            let folders = folders.collect();
            let videos =
                entries.into_iter().filter(File::is_video_type).map(|file| (file.name.clone(), file)).collect();
            Ok::<_, debrid::Error>(FolderListing { folders, videos })
        })
        .await?;
        Ok(contents)
    }

    async fn resolve_inner(&self, params: &ResolveParams) -> MochResult<Resolved> {
        let token = token(&params.api_key);
        let info_hash = params.info_hash.as_str();
        if info_hash == "null" {
            let file_id = params.file_index.ok_or_else(|| MochError::message("Missing Putio file id"))?;
            return self.storage_url(token, file_id).await.map(Resolved::Url);
        }
        let torrent = self.create_or_find_torrent(token, info_hash).await?;
        let label = index_text(params.file_index);
        if status_ready(&torrent.status) {
            return self.unrestrict_link(token, &torrent, &params.cached_entry_info, params.file_index).await;
        }
        if status_downloading(&torrent.status) {
            tracing::info!(moch = "putio", %info_hash, file_index = %label, "Downloading to Putio");
            return Ok(StaticResponse::Downloading.into());
        }
        if status_error(&torrent.status) {
            tracing::info!(moch = "putio", %info_hash, file_index = %label, "Retrying downloading to Putio");
            return self.retry_create_torrent(params).await;
        }
        Err(MochError::message(quoted(format!("Unexpected Putio transfer status {}", torrent.status))))
    }

    async fn create_or_find_torrent(&self, token: &str, info_hash: &str) -> MochResult<Transfer> {
        match self.find_torrent(token, info_hash).await? {
            Some(torrent) => Ok(torrent),
            None => self.create_torrent(token, info_hash).await,
        }
    }

    async fn retry_create_torrent(&self, params: &ResolveParams) -> MochResult<Resolved> {
        let token = token(&params.api_key);
        let torrent = self.create_torrent(token, &params.info_hash).await?;
        if status_ready(&torrent.status) {
            self.unrestrict_link(token, &torrent, &params.cached_entry_info, params.file_index).await
        } else {
            Ok(StaticResponse::FailedDownload.into())
        }
    }

    async fn find_torrent(&self, token: &str, info_hash: &str) -> MochResult<Option<Transfer>> {
        let transfers = self.client.list_transfers(token).await?;
        let mut found: Vec<Transfer> =
            transfers.into_iter().filter(|transfer| transfer.source.to_lowercase().contains(info_hash)).collect();
        let index = found.iter().position(|transfer| !status_error(&transfer.status)).unwrap_or(0);
        if index >= found.len() {
            return Ok(None);
        }
        let torrent = found.swap_remove(index);
        if !torrent.userfile_exists.unwrap_or(false) {
            self.client.cancel_transfers(token, &[torrent.id]).await?;
            return Ok(None);
        }
        Ok(Some(torrent))
    }

    async fn create_torrent(&self, token: &str, info_hash: &str) -> MochResult<Transfer> {
        let magnet = magnet_link(self.context.repository.as_ref(), info_hash).await;
        let added = self.client.add_transfer(token, &magnet).await?;
        self.poll_transfer(token, added.id).await
    }

    async fn poll_transfer(&self, token: &str, id: i64) -> MochResult<Transfer> {
        let mut polls = 0;
        loop {
            let torrent = self.client.get_transfer(token, id).await?;
            if !status_processing(&torrent.status) || polls >= MAX_POLLS {
                return Ok(torrent);
            }
            tokio::time::sleep(POLL_RATE).await;
            polls += 1;
        }
    }

    async fn unrestrict_link(
        &self,
        token: &str,
        torrent: &Transfer,
        target_file_name: &str,
        file_index: Option<i64>,
    ) -> MochResult<Resolved> {
        let target = self.target_file(token, torrent, target_file_name, file_index).await?;
        self.storage_url(token, target.id).await.map(Resolved::Url)
    }

    async fn storage_url(&self, token: &str, file_id: i64) -> MochResult<String> {
        self.client
            .storage_url(token, file_id)
            .await?
            .ok_or_else(|| MochError::message(quoted("Unexpected Putio storage url response")))
    }

    async fn target_file(
        &self,
        token: &str,
        torrent: &Transfer,
        target_file_name: &str,
        file_index: Option<i64>,
    ) -> MochResult<File> {
        let mut files = match torrent.file_id {
            Some(file_id) => self.files(token, &file_id.to_string()).await?,
            None => Vec::new(),
        };
        let mut videos: Vec<File> = Vec::new();
        let mut target = None;
        while target.is_none() && !files.is_empty() {
            let folders: Vec<File> = files.iter().filter(|file| file.is_folder()).cloned().collect();
            videos.extend(files.iter().filter(|file| is_video(&file.name)).cloned());
            videos.sort_by_key(|video| std::cmp::Reverse(video.size));
            target = select_target(&videos, folders.is_empty(), file_index.is_some(), target_file_name);
            files = if target.is_none() {
                let listings = futures::future::try_join_all(
                    folders.iter().map(|folder| async move { self.files(token, &folder.id.to_string()).await }),
                )
                .await?;
                listings.into_iter().flatten().collect()
            } else {
                Vec::new()
            };
        }
        target.ok_or_else(|| {
            MochError::message(quoted(format!(
                "No target file found for Putio [{}] {target_file_name}",
                torrent.hash.as_deref().unwrap_or("null")
            )))
        })
    }

    async fn files(&self, token: &str, file_id: &str) -> MochResult<Vec<File>> {
        match self.client.list_files(token, file_id).await {
            Ok(listing) => Ok(listing.into_entries()),
            Err(error) => {
                let mut body = error.body().cloned().unwrap_or_else(|| json!({ "error_message": error.to_string() }));
                if let Some(object) = body.as_object_mut() {
                    object.insert("path".to_owned(), json!(format!("/v2/files/list?parent_id={file_id}")));
                }
                Err(debrid::Error::api(None, body).into())
            }
        }
    }
}

fn static_for_error(error: &MochError, params: &ResolveParams) -> MochResult<Resolved> {
    let denied = error.provider().and_then(debrid::Error::status).is_some_and(|status| status == 401 || status == 402);
    let rules = [Rule::new(denied, StaticResponse::FailedAccess, "Access denied to Putio {}")];
    static_or_err(&rules, &resolve_target(params), || adding_error("Putio", message_json(error)))
}

fn message_json(error: &MochError) -> String {
    match error {
        MochError::Provider(error) => match error.as_ref() {
            debrid::Error::Api { body, .. } => body.to_string(),
            other => quoted(other.to_string()),
        },
        MochError::Message(message) => message.clone(),
        other => quoted(other.to_string()),
    }
}

fn select_target(videos: &[File], no_folders: bool, has_file_index: bool, target_file_name: &str) -> Option<File> {
    let by_name =
        if has_file_index { videos.iter().find(|video| same_filename(target_file_name, &video.name)) } else { None };
    by_name.or_else(|| if no_folders { videos.first() } else { None }).cloned()
}

fn token(api_key: &str) -> &str {
    api_key.rsplit('@').next().unwrap_or(api_key)
}

fn decode_info_hash(source: &str) -> Option<String> {
    let url = Url::parse(source).ok()?;
    url.query_pairs()
        .filter(|(key, _)| key == "xt")
        .find_map(|(_, value)| value.strip_prefix("urn:btih:").map(str::to_lowercase))
        .filter(|hash| hash.len() == 40 && hash.chars().all(|character| character.is_ascii_hexdigit()))
}

fn released(created_at: &str) -> Option<String> {
    let utc = DateTime::parse_from_rfc3339(created_at)
        .map(|date| date.to_utc())
        .or_else(|_| NaiveDateTime::parse_from_str(created_at, "%Y-%m-%dT%H:%M:%S%.f").map(|date| date.and_utc()))
        .ok()?;
    Some(utc.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn status_error(status: &str) -> bool {
    status == "ERROR"
}

fn status_downloading(status: &str) -> bool {
    DOWNLOADING.contains(&status)
}

fn status_processing(status: &str) -> bool {
    PROCESSING.contains(&status)
}

fn status_ready(status: &str) -> bool {
    READY.contains(&status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(id: i64, name: &str, size: i64) -> File {
        File { id, name: name.to_owned(), size, file_type: "VIDEO".to_owned(), ..File::default() }
    }

    fn params(file_index: Option<i64>) -> ResolveParams {
        ResolveParams {
            moch_key: KEY.to_owned(),
            api_key: "1@token".to_owned(),
            info_hash: "abc".to_owned(),
            file_index,
            cached_entry_info: String::new(),
            ip: None,
            host: String::new(),
            is_browser: false,
        }
    }

    fn api_error(status: u16) -> MochError {
        debrid::Error::api(Some(status), json!({ "error_type": "x", "status_code": status })).into()
    }

    #[test]
    fn completed_and_seeding_are_ready() {
        assert!(status_ready("COMPLETED"));
        assert!(status_ready("SEEDING"));
        assert!(!status_ready("DOWNLOADING"));
    }

    #[test]
    fn queued_and_active_states_are_downloading() {
        for status in ["WAITING", "IN_QUEUE", "PREPARING_DOWNLOAD", "DOWNLOADING", "COMPLETING"] {
            assert!(status_downloading(status));
        }
        assert!(!status_downloading("ERROR"));
    }

    #[test]
    fn only_waiting_queued_and_completing_are_processing() {
        assert!(status_processing("WAITING"));
        assert!(status_processing("IN_QUEUE"));
        assert!(status_processing("COMPLETING"));
        assert!(!status_processing("DOWNLOADING"));
    }

    #[test]
    fn only_error_status_is_error() {
        assert!(status_error("ERROR"));
        assert!(!status_error("COMPLETED"));
    }

    #[test]
    fn token_is_taken_after_last_at_sign() {
        assert_eq!(token("123@abcdef"), "abcdef");
        assert_eq!(token("a@b@c"), "c");
    }

    #[test]
    fn token_without_at_sign_is_whole_key() {
        assert_eq!(token("abcdef"), "abcdef");
    }

    #[test]
    fn info_hash_is_decoded_from_magnet_source() {
        let source = "magnet:?xt=urn:btih:ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD&dn=Name&tr=udp%3A%2F%2Ft";
        assert_eq!(decode_info_hash(source).as_deref(), Some("abcdefabcdefabcdefabcdefabcdefabcdefabcd"));
    }

    #[test]
    fn info_hash_is_absent_for_non_magnet_source() {
        assert_eq!(decode_info_hash("https://example.com/file.torrent"), None);
    }

    #[test]
    fn naive_timestamps_are_read_as_utc() {
        assert_eq!(released("2024-01-02T03:04:05").as_deref(), Some("2024-01-02T03:04:05.000Z"));
    }

    #[test]
    fn offset_timestamps_are_converted_to_utc() {
        assert_eq!(released("2024-01-02T03:04:05+02:00").as_deref(), Some("2024-01-02T01:04:05.000Z"));
    }

    #[test]
    fn invalid_timestamps_have_no_release_date() {
        assert_eq!(released("yesterday"), None);
    }

    #[test]
    fn target_by_name_matches_when_file_index_is_set() {
        let videos = [video(1, "Show.S01E01.mkv", 20), video(2, "Show.S01E02.mkv", 10)];
        let target = select_target(&videos, false, true, "Show.S01E02.mkv").map(|file| file.id);
        assert_eq!(target, Some(2));
    }

    #[test]
    fn target_name_must_end_with_video_name() {
        let videos = [video(1, "E02.mkv", 20)];
        let target = select_target(&videos, true, true, "Show.S01E02.mkv").map(|file| file.id);
        assert_eq!(target, Some(1));
        assert!(select_target(&videos, false, true, "Show.S01E03.mkv").is_none());
    }

    #[test]
    fn largest_video_is_used_without_file_index() {
        let videos = [video(1, "big.mkv", 20), video(2, "small.mkv", 10)];
        assert_eq!(select_target(&videos, true, false, "").map(|file| file.id), Some(1));
    }

    #[test]
    fn unmatched_name_falls_back_to_largest_only_without_folders() {
        let videos = [video(1, "big.mkv", 20)];
        assert_eq!(select_target(&videos, true, true, "other.mkv").map(|file| file.id), Some(1));
        assert!(select_target(&videos, false, true, "other.mkv").is_none());
    }

    #[test]
    fn largest_video_is_not_used_while_folders_remain() {
        let videos = [video(1, "big.mkv", 20)];
        assert!(select_target(&videos, false, false, "").is_none());
    }

    #[test]
    fn unauthorized_errors_resolve_to_failed_access() {
        let result = static_for_error(&api_error(401), &params(Some(1)));
        assert_eq!(result.ok(), Some(Resolved::Message(StaticResponse::FailedAccess)));
    }

    #[test]
    fn payment_required_errors_resolve_to_failed_access() {
        let result = static_for_error(&api_error(402), &params(None));
        assert_eq!(result.ok(), Some(Resolved::Message(StaticResponse::FailedAccess)));
    }

    #[test]
    fn other_api_errors_are_rejected_with_body() {
        let error = static_for_error(&api_error(500), &params(None)).expect_err("rejected");
        assert_eq!(error.to_string(), r#"Failed Putio adding torrent {"error_type":"x","status_code":500}"#);
    }

    #[test]
    fn plain_message_errors_are_rejected_unchanged() {
        let error = static_for_error(&MochError::message("\"No target\""), &params(None)).expect_err("rejected");
        assert_eq!(error.to_string(), "Failed Putio adding torrent \"No target\"");
    }

    #[test]
    fn transport_style_errors_are_rejected_as_quoted_message() {
        let error = static_for_error(&MochError::TimedOut, &params(None)).expect_err("rejected");
        assert_eq!(error.to_string(), "Failed Putio adding torrent \"Timed out\"");
    }

    #[test]
    fn common_errors_pass_through_to_common_error() {
        assert_eq!(common_error(&CommonError::BadToken.into()), Some(CommonError::BadToken));
        assert_eq!(common_error(&api_error(401)), None);
    }
}
