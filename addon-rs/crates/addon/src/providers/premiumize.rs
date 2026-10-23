use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat};
use debrid::premiumize::{Client, Content, DirectFile, Transfer};
use serde_json::Value;

use super::{
    CachedStreams, CommonError, Context, Moch, MochError, MochResult, ResolveParams, Resolved,
    helper::{FolderListing, same_filename, walk_folders},
    static_videos::StaticResponse,
    support::{
        CachedName, Rule, adding_error, build_cached, index_text, padded_info_hashes, quoted, resolve_target,
        static_or_err,
    },
};
use crate::{
    domain::config::Config,
    domain::extension::is_video,
    domain::models::{CatalogMeta, ItemMeta, Video, VideoStream},
    domain::stream::Stream,
    infrastructure::magnet::magnet_link,
};

const KEY: &str = "premiumize";
const CHUNK_SIZE: usize = 100;
const ACCESS_DENIED: &[&str] = &["Account not premium", "payment issue"];
const BAD_TOKEN: &[&str] = &["Not logged in"];
const LIMIT_EXCEEDED: &[&str] = &[
    "Fair use limit reached!",
    "You already have a maximum of 25 active downloads in progress!",
    "Your space is full! Please delete old files first!",
    "Bandwidth limit exceeded",
    "Rate limit exceeded",
];
const FAILED_DOWNLOAD: &[&str] = &["Error downloading this file", "Unsupported link for direct download"];

struct Premiumize {
    context: Arc<Context>,
    client: Client,
}

pub fn build(context: Arc<Context>) -> Box<dyn Moch> {
    let client = Client::new(context.http.clone());
    Box::new(Premiumize { context, client })
}

#[async_trait]
impl Moch for Premiumize {
    async fn cached_streams(
        &self,
        streams: &[Stream],
        api_key: &str,
        _ip: Option<&str>,
    ) -> MochResult<Option<CachedStreams>> {
        let chunks = futures::future::join_all(
            streams.chunks(CHUNK_SIZE).map(|chunk| self.chunk_cached_streams(api_key, chunk)),
        )
        .await;
        let mut all = CachedStreams::new();
        for chunk in chunks {
            all.extend(chunk?);
        }
        Ok(Some(all))
    }

    async fn catalog(&self, api_key: &str, _catalog_id: &str, config: &Config) -> MochResult<Vec<CatalogMeta>> {
        if config.skip() > 0 {
            return Ok(Vec::new());
        }
        let folder = self.client.list_folder(api_key, None, None).await?;
        Ok(folder
            .content
            .into_iter()
            .filter(|content| content.kind == "folder")
            .map(|content| CatalogMeta {
                id: format!("{KEY}:{}", content.id),
                kind: "other".to_owned(),
                name: content.name,
            })
            .collect())
    }

    async fn item_meta(&self, item_id: &str, api_key: &str, ip: Option<&str>) -> MochResult<ItemMeta> {
        let root_folder = self.client.list_folder(api_key, Some(item_id), None).await?;
        let info_hash = self.find_info_hash(api_key, item_id).await?;
        let contents = walk_folders(item_id, |folder_id| async move {
            let folder = self.client.list_folder(api_key, Some(&folder_id), ip).await?;
            Ok::<_, MochError>(folder_listing(folder.content))
        })
        .await?;
        let videos = contents
            .into_iter()
            .enumerate()
            .map(|(index, (name, file))| Video {
                id: format!("{KEY}:{}:{index}", file.id),
                title: name,
                released: released(file.created_at, index),
                streams: vec![VideoStream {
                    url: file.link.or(file.stream_link).unwrap_or_default(),
                    behavior_hints: None,
                }],
                ..Video::default()
            })
            .collect();
        Ok(ItemMeta {
            id: format!("{KEY}:{item_id}"),
            kind: "other".to_owned(),
            name: root_folder.name,
            info_hash,
            videos,
            ..ItemMeta::default()
        })
    }

    async fn resolve(&self, params: &ResolveParams) -> MochResult<Resolved> {
        let result = match self.cached_link(params, params.ip.as_deref(), params.is_browser).await {
            Ok(Some(link)) => Ok(link),
            Ok(None) => self.resolve_torrent(params).await,
            Err(error) => Err(error),
        };
        result.or_else(|error| static_for_error(&error, params))
    }

    fn to_common_error(&self, error: &MochError) -> Option<CommonError> {
        common_error(error)
    }
}

impl Premiumize {
    async fn chunk_cached_streams(&self, api_key: &str, streams: &[Stream]) -> MochResult<CachedStreams> {
        let available = match self.client.check_cache(api_key, &padded_info_hashes(streams)).await {
            Ok(available) => available,
            Err(error) => {
                let error = MochError::from(error);
                if self.to_common_error(&error).is_some() {
                    return Err(error);
                }
                tracing::warn!(moch = "premiumize", error = %error_message(&error), "Failed Premiumize cached torrent availability request");
                Vec::new()
            }
        };
        Ok(build_cached(api_key, streams, CachedName::Filename, |position, _, _| {
            available.get(position).copied().unwrap_or(false)
        }))
    }

    async fn resolve_torrent(&self, params: &ResolveParams) -> MochResult<Resolved> {
        let torrent = self.create_torrent(params).await?;
        if status_ready(&torrent.status) {
            return match self.cached_link(params, params.ip.as_deref(), params.is_browser).await? {
                Some(link) => Ok(link),
                None => Err(adding_error("Premiumize", serde_json::to_string(&torrent).unwrap_or_default())),
            };
        }
        if status_downloading(&torrent.status) {
            tracing::info!(
                moch = "premiumize",
                info_hash = %params.info_hash,
                file_index = %index_text(params.file_index),
                "Downloading to Premiumize"
            );
            return Ok(StaticResponse::Downloading.into());
        }
        if status_error(&torrent.status) {
            tracing::info!(
                moch = "premiumize",
                info_hash = %params.info_hash,
                file_index = %index_text(params.file_index),
                "Retrying downloading to Premiumize"
            );
            return self.retry_create_torrent(params).await;
        }
        Err(adding_error("Premiumize", serde_json::to_string(&torrent).unwrap_or_default()))
    }

    async fn cached_link(
        &self,
        params: &ResolveParams,
        ip: Option<&str>,
        is_browser: bool,
    ) -> MochResult<Option<Resolved>> {
        let magnet = format!("magnet:?xt=urn:btih:{}", params.info_hash);
        let cached = match self.client.direct_download(&params.api_key, &magnet, ip).await {
            Ok(cached) => cached,
            Err(error) => {
                let error = MochError::from(error);
                return if is_failed_download_error(&error) { Ok(None) } else { Err(error) };
            }
        };
        if cached.content.is_empty() {
            return Ok(None);
        }
        let Some(target) = select_video(&cached.content, params.file_index, &params.cached_entry_info) else {
            tracing::info!(
                moch = "premiumize",
                info_hash = %params.info_hash,
                file_index = %index_text(params.file_index),
                "Only Premiumize archive is available"
            );
            return Ok(Some(StaticResponse::FailedRar.into()));
        };
        Ok(pick_link(target, is_browser).map(Resolved::Url))
    }

    async fn find_torrent(&self, api_key: &str, item_id: &str) -> MochResult<Transfer> {
        let transfers = self.client.list_transfers(api_key).await?;
        transfers
            .into_iter()
            .find(|transfer| transfer.id == item_id)
            .ok_or_else(|| MochError::message("No recent torrent found"))
    }

    async fn find_info_hash(&self, api_key: &str, item_id: &str) -> MochResult<Option<String>> {
        let transfers = self.client.list_transfers(api_key).await?;
        Ok(transfers
            .iter()
            .find(|transfer| {
                transfer.file_id.as_deref() == Some(item_id) || transfer.folder_id.as_deref() == Some(item_id)
            })
            .and_then(|transfer| transfer.src.as_deref())
            .and_then(decode_info_hash))
    }

    async fn create_torrent(&self, params: &ResolveParams) -> MochResult<Transfer> {
        let magnet = magnet_link(self.context.repository.as_ref(), &params.info_hash).await;
        let id = self.client.create_transfer(&params.api_key, &magnet).await?;
        self.find_torrent(&params.api_key, &id).await
    }

    async fn retry_create_torrent(&self, params: &ResolveParams) -> MochResult<Resolved> {
        let torrent = self.create_torrent(params).await?;
        if !status_ready(&torrent.status) {
            return Ok(StaticResponse::FailedDownload.into());
        }
        self.cached_link(params, None, false)
            .await?
            .ok_or_else(|| adding_error("Premiumize", serde_json::to_string(&torrent).unwrap_or_default()))
    }
}

fn common_error(error: &MochError) -> Option<CommonError> {
    match error {
        MochError::Common(common) => Some(*common),
        _ if is_bad_token_error(error) => Some(CommonError::BadToken),
        _ if is_access_denied_error(error) => Some(CommonError::AccessDenied),
        _ => None,
    }
}

fn static_for_error(error: &MochError, params: &ResolveParams) -> MochResult<Resolved> {
    let rules = [
        Rule::new(
            is_access_denied_error(error) || is_bad_token_error(error),
            StaticResponse::FailedAccess,
            "Access denied to Premiumize {}",
        ),
        Rule::new(is_limit_exceeded_error(error), StaticResponse::LimitsExceeded, "Limits exceeded in Premiumize {}"),
    ];
    static_or_err(&rules, &resolve_target(params), || adding_error("Premiumize", quoted(error_message(error))))
}

fn select_video<'a>(
    content: &'a [DirectFile],
    file_index: Option<i64>,
    target_file_name: &str,
) -> Option<&'a DirectFile> {
    let mut videos: Vec<&DirectFile> = content.iter().filter(|file| is_video(&file.path)).collect();
    videos.sort_by(|a, b| b.size.total_cmp(&a.size));
    file_index
        .and_then(|_| videos.iter().find(|video| same_filename(&video.path, target_file_name)).copied())
        .or_else(|| videos.first().copied())
}

fn pick_link(target: &DirectFile, is_browser: bool) -> Option<String> {
    let stream_link = target
        .stream_link
        .as_deref()
        .filter(|link| !link.is_empty() && is_browser && target.transcode_status.as_deref() == Some("finished"));
    stream_link.map(str::to_owned).or_else(|| target.link.clone()).filter(|link| !link.is_empty())
}

fn folder_listing(contents: Vec<Content>) -> FolderListing<Content> {
    let folders = contents
        .iter()
        .filter(|content| content.kind == "folder")
        .map(|content| (content.id.clone(), content.name.clone()))
        .collect();
    let videos = contents
        .into_iter()
        .filter(|content| content.kind == "file" && is_video(&content.name))
        .map(|content| (content.name.clone(), content))
        .collect();
    FolderListing { folders, videos }
}

fn released(created_at: Option<f64>, index: usize) -> Option<String> {
    let millis = (created_at? * 1000.0) as i64 - index as i64;
    DateTime::from_timestamp_millis(millis).map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn decode_info_hash(src: &str) -> Option<String> {
    let query = src.split_once('?')?.1;
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == "xt")
        .and_then(|(_, value)| value.strip_prefix("urn:btih:"))
        .map(str::to_lowercase)
}

fn error_message(error: &MochError) -> String {
    match error.provider() {
        Some(provider) => provider
            .body()
            .and_then(|body| body.get("message"))
            .and_then(Value::as_str)
            .map_or_else(|| provider.to_string(), str::to_owned),
        None => error.to_string(),
    }
}

fn provider_message_contains(error: &MochError, values: &[&str]) -> bool {
    error.provider().is_some() && {
        let message = error_message(error);
        values.iter().any(|value| message.contains(value))
    }
}

fn is_access_denied_error(error: &MochError) -> bool {
    provider_message_contains(error, ACCESS_DENIED)
}

fn is_bad_token_error(error: &MochError) -> bool {
    provider_message_contains(error, BAD_TOKEN)
}

fn is_limit_exceeded_error(error: &MochError) -> bool {
    provider_message_contains(error, LIMIT_EXCEEDED)
}

fn is_failed_download_error(error: &MochError) -> bool {
    provider_message_contains(error, FAILED_DOWNLOAD)
}

fn status_error(status: &str) -> bool {
    matches!(status, "deleted" | "error" | "timeout")
}

fn status_downloading(status: &str) -> bool {
    matches!(status, "waiting" | "queued" | "running")
}

fn status_ready(status: &str) -> bool {
    matches!(status, "finished" | "seeding")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn api_error(message: &str) -> MochError {
        debrid::Error::api(Some(200), json!({ "status": "error", "message": message })).into()
    }

    fn params() -> ResolveParams {
        ResolveParams {
            moch_key: KEY.to_owned(),
            api_key: "key".to_owned(),
            info_hash: "abc".to_owned(),
            file_index: Some(2),
            cached_entry_info: String::new(),
            ip: None,
            host: String::new(),
            is_browser: false,
        }
    }

    #[test]
    fn transfer_statuses_are_classified() {
        assert!(status_ready("finished") && status_ready("seeding"));
        assert!(status_downloading("waiting") && status_downloading("queued") && status_downloading("running"));
        assert!(status_error("deleted") && status_error("error") && status_error("timeout"));
        assert!(!status_ready("running") && !status_error("finished"));
    }

    #[test]
    fn not_logged_in_is_bad_token() {
        assert_eq!(common_error(&api_error("Not logged in.")), Some(CommonError::BadToken));
    }

    #[test]
    fn premium_and_payment_errors_are_access_denied() {
        assert_eq!(common_error(&api_error("Account not premium.")), Some(CommonError::AccessDenied));
        assert_eq!(common_error(&api_error("There is a payment issue")), Some(CommonError::AccessDenied));
    }

    #[test]
    fn unrelated_errors_are_not_common() {
        assert_eq!(common_error(&api_error("boom")), None);
        assert_eq!(common_error(&MochError::message("Not logged in")), None);
    }

    #[test]
    fn limit_messages_are_limit_exceeded() {
        assert!(is_limit_exceeded_error(&api_error("Fair use limit reached!")));
        assert!(is_limit_exceeded_error(&api_error("Your space is full! Please delete old files first!")));
        assert!(!is_limit_exceeded_error(&api_error("Something else")));
    }

    #[test]
    fn unsupported_direct_download_is_a_failed_download() {
        assert!(is_failed_download_error(&api_error("Unsupported link for direct download")));
    }

    #[test]
    fn access_denied_resolves_to_static_video() {
        let url = static_for_error(&api_error("Account not premium."), &params()).expect("static video");
        assert_eq!(url, Resolved::Message(StaticResponse::FailedAccess));
    }

    #[test]
    fn limit_error_resolves_to_static_video() {
        let url = static_for_error(&api_error("Rate limit exceeded"), &params()).expect("static video");
        assert_eq!(url, Resolved::Message(StaticResponse::LimitsExceeded));
    }

    #[test]
    fn unknown_error_is_rejected_with_json_message() {
        let error = static_for_error(&api_error("boom"), &params()).expect_err("rejection");
        assert_eq!(error.to_string(), "Failed Premiumize adding torrent \"boom\"");
    }

    fn direct_file(path: &str, size: f64) -> DirectFile {
        DirectFile {
            path: path.to_owned(),
            size,
            link: Some(format!("http://link/{path}")),
            stream_link: Some(format!("http://stream/{path}")),
            transcode_status: Some("finished".to_owned()),
        }
    }

    #[test]
    fn largest_video_is_selected_without_file_index() {
        let files = [direct_file("a.mkv", 1.0), direct_file("b.mkv", 9.0), direct_file("c.txt", 99.0)];
        assert_eq!(select_video(&files, None, "a.mkv").map(|file| file.path.as_str()), Some("b.mkv"));
    }

    #[test]
    fn video_matching_filename_is_selected_with_file_index() {
        let files = [direct_file("dir/a.mkv", 1.0), direct_file("dir/b.mkv", 9.0)];
        assert_eq!(select_video(&files, Some(0), "a.mkv").map(|file| file.path.as_str()), Some("dir/a.mkv"));
    }

    #[test]
    fn unmatched_filename_falls_back_to_largest_video() {
        let files = [direct_file("a.mkv", 1.0), direct_file("b.mkv", 9.0)];
        assert_eq!(select_video(&files, Some(0), "zzz.mkv").map(|file| file.path.as_str()), Some("b.mkv"));
    }

    #[test]
    fn no_videos_selects_nothing() {
        assert!(select_video(&[direct_file("a.rar", 1.0)], None, "a.rar").is_none());
    }

    #[test]
    fn browser_prefers_finished_transcode_stream_link() {
        let file = direct_file("a.mkv", 1.0);
        assert_eq!(pick_link(&file, true), Some("http://stream/a.mkv".to_owned()));
        assert_eq!(pick_link(&file, false), Some("http://link/a.mkv".to_owned()));
    }

    #[test]
    fn unfinished_transcode_uses_direct_link() {
        let file = DirectFile { transcode_status: Some("running".to_owned()), ..direct_file("a.mkv", 1.0) };
        assert_eq!(pick_link(&file, true), Some("http://link/a.mkv".to_owned()));
    }

    #[test]
    fn info_hash_is_decoded_from_magnet_source() {
        assert_eq!(decode_info_hash("magnet:?dn=x&xt=urn:btih:ABCDEF0123"), Some("abcdef0123".to_owned()));
        assert_eq!(decode_info_hash("https://example.com/file.torrent"), None);
    }

    #[test]
    fn released_subtracts_index_milliseconds() {
        assert_eq!(released(Some(1_700_000_000.0), 3), Some("2023-11-14T22:13:19.997Z".to_owned()));
        assert_eq!(released(None, 0), None);
    }

    #[test]
    fn folder_listing_keeps_folders_and_video_files_only() {
        let content = |id: &str, name: &str, kind: &str| Content {
            id: id.to_owned(),
            name: name.to_owned(),
            kind: kind.to_owned(),
            ..Content::default()
        };
        let listing = folder_listing(vec![
            content("1", "Sub", "folder"),
            content("2", "a.mkv", "file"),
            content("3", "a.srt", "file"),
        ]);
        assert_eq!(listing.folders, vec![("1".to_owned(), "Sub".to_owned())]);
        assert_eq!(listing.videos.len(), 1);
        assert_eq!(listing.videos[0].0, "a.mkv");
    }
}
