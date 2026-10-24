use std::sync::Arc;

use async_trait::async_trait;
use chrono::{SecondsFormat, Utc};
use debrid::offcloud::{CachedFile, Client, CloudRequest};

use super::{
    CachedStreams, CommonError, Context, Moch, MochError, MochResult, ResolveParams, Resolved,
    helper::same_filename,
    static_videos::StaticResponse,
    support::{
        CachedName, Rule, adding_error, build_cached, error_text, index_text, padded_info_hashes, quoted,
        resolve_target, static_or_err,
    },
};
use crate::{
    domain::config::Config,
    domain::extension::{is_archive, is_video},
    domain::models::{CatalogMeta, ItemMeta, Video, VideoStream},
    domain::stream::Stream,
    infrastructure::magnet::{encode_magnet, magnet_link},
};

const KEY: &str = "offcloud";
const BAD_TOKEN: &[&str] = &["NOAUTH", "Unauthorized"];
const ACCESS_DENIED: &str = "not premium";
const LIMIT_EXCEEDED: &[&str] = &["maximum of 25 active downloads", "Fair use limit reached"];
const FAILED_DOWNLOAD: &[&str] = &["Unsupported link for direct download", "Error downloading this file"];

struct Offcloud {
    context: Arc<Context>,
    client: Client,
}

pub fn build(context: Arc<Context>) -> Box<dyn Moch> {
    let client = Client::new(context.http.clone());
    Box::new(Offcloud { context, client })
}

#[async_trait]
impl Moch for Offcloud {
    async fn cached_streams(
        &self,
        streams: &[Stream],
        api_key: &str,
        _ip: Option<&str>,
    ) -> MochResult<Option<CachedStreams>> {
        let magnets: Vec<String> =
            padded_info_hashes(streams).iter().map(|info_hash| encode_magnet(info_hash, None, &[])).collect();
        let available = match self.client.cache_info(api_key, &magnets).await {
            Ok(available) => available,
            Err(error) => {
                let error = MochError::from(error);
                if common_error(&error).is_some() {
                    return Err(error);
                }
                tracing::warn!(moch = "offcloud", error = %offcloud_text(&error), "Failed Offcloud cached torrent availability request");
                return Ok(None);
            }
        };
        let cached = build_cached(api_key, streams, CachedName::Filename, |position, _, _| {
            available.get(position).is_some_and(|info| info.cached)
        });
        Ok(Some(cached))
    }

    async fn catalog(&self, api_key: &str, _catalog_id: &str, config: &Config) -> MochResult<Vec<CatalogMeta>> {
        if config.skip() > 0 {
            return Ok(Vec::new());
        }
        let history = self.client.cloud_history(api_key).await?;
        Ok(history
            .into_iter()
            .filter(|item| item.status.as_deref() == Some("downloaded"))
            .map(|item| CatalogMeta {
                id: format!("{KEY}:{}", item.request_id),
                kind: "other".to_owned(),
                name: item.file_name,
            })
            .collect())
    }

    async fn item_meta(&self, item_id: &str, api_key: &str, _ip: Option<&str>) -> MochResult<ItemMeta> {
        let files = self.client.cloud_explore(api_key, item_id).await.map_err(meta_error)?;
        let Some(first) = files.first() else {
            return Err(CommonError::NotFound.into());
        };
        let now = Utc::now();
        let videos = files
            .iter()
            .filter(|file| is_video(&file.path))
            .enumerate()
            .map(|(index, file)| Video {
                id: format!("{KEY}:{item_id}:{index}"),
                title: file.path.clone(),
                released: Some(
                    (now - chrono::Duration::milliseconds(index as i64)).to_rfc3339_opts(SecondsFormat::Millis, true),
                ),
                streams: vec![VideoStream { url: file.url.clone(), behavior_hints: None }],
                ..Video::default()
            })
            .collect();
        Ok(ItemMeta {
            id: format!("{KEY}:{item_id}"),
            kind: "other".to_owned(),
            name: first.path.split('/').next().unwrap_or_default().to_owned(),
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

impl Offcloud {
    async fn resolve_inner(&self, params: &ResolveParams) -> MochResult<Resolved> {
        let magnet = magnet_link(self.context.repository.as_ref(), &params.info_hash).await;
        match self.cached_link(&magnet, params).await? {
            Some(link) => Ok(link),
            None => self.request_download(&magnet, params).await,
        }
    }

    async fn cached_link(&self, magnet: &str, params: &ResolveParams) -> MochResult<Option<Resolved>> {
        let files = match self.client.cache_download(&params.api_key, magnet).await {
            Ok(files) => files,
            Err(error) => {
                let error = MochError::from(error);
                return if is_failed_download(&error) { Ok(None) } else { Err(error) };
            }
        };
        if files.is_empty() {
            return Ok(None);
        }
        let videos = sorted_videos(&files);
        if let Some(target) = target_video(&videos, &params.cached_entry_info, params.file_index) {
            return Ok(Some(Resolved::Url(target.url.clone())));
        }
        tracing::warn!(
            moch = "offcloud",
            info_hash = %params.info_hash,
            file_index = %index_text(params.file_index),
            "No Offcloud video files found"
        );
        Ok(Some(
            if files.iter().any(|file| is_archive(&file.filename)) {
                StaticResponse::FailedRar
            } else {
                StaticResponse::FailedOpening
            }
            .into(),
        ))
    }

    async fn request_download(&self, magnet: &str, params: &ResolveParams) -> MochResult<Resolved> {
        let download = self.client.cloud_download(&params.api_key, magnet).await?;
        let label = index_text(params.file_index);
        if status_ready(&download) {
            return match self.cached_link(magnet, params).await? {
                Some(link) => Ok(link),
                None => Err(adding_error("Offcloud", json_text(&download))),
            };
        }
        if status_downloading(&download) {
            tracing::info!(moch = "offcloud", info_hash = %params.info_hash, file_index = %label, "Downloading to Offcloud");
            return Ok(StaticResponse::Downloading.into());
        }
        if status_error(&download) {
            tracing::warn!(moch = "offcloud", info_hash = %params.info_hash, file_index = %label, "Failed download in Offcloud");
            return Ok(StaticResponse::FailedDownload.into());
        }
        Err(adding_error("Offcloud", json_text(&download)))
    }
}

fn meta_error(error: debrid::Error) -> MochError {
    if error.to_string().contains("Request not found") { CommonError::NotFound.into() } else { error.into() }
}

fn static_for_error(error: &MochError, params: &ResolveParams) -> MochResult<Resolved> {
    let rules = [
        Rule::new(
            is_access_denied(error) || is_bad_token(error),
            StaticResponse::FailedAccess,
            "Access denied to Offcloud {}",
        ),
        Rule::new(is_limit_exceeded(error), StaticResponse::LimitsExceeded, "Limits exceeded in Offcloud {}"),
        Rule::new(is_failed_download(error), StaticResponse::FailedDownload, "Failed download in Offcloud {}"),
    ];
    static_or_err(&rules, &resolve_target(params), || adding_error("Offcloud", quoted(offcloud_text(error))))
}

fn common_error(error: &MochError) -> Option<CommonError> {
    if let MochError::Common(common) = error {
        return Some(*common);
    }
    if is_bad_token(error) {
        Some(CommonError::BadToken)
    } else if is_access_denied(error) {
        Some(CommonError::AccessDenied)
    } else {
        None
    }
}

fn offcloud_text(error: &MochError) -> String {
    error_text(error, debrid::offcloud::error_message)
}

fn is_bad_token(error: &MochError) -> bool {
    let text = offcloud_text(error);
    BAD_TOKEN.iter().any(|value| text.contains(value))
}

fn is_access_denied(error: &MochError) -> bool {
    offcloud_text(error).contains(ACCESS_DENIED)
}

fn is_limit_exceeded(error: &MochError) -> bool {
    let text = offcloud_text(error);
    LIMIT_EXCEEDED.iter().any(|value| text.contains(value))
}

fn is_failed_download(error: &MochError) -> bool {
    let text = offcloud_text(error);
    FAILED_DOWNLOAD.iter().any(|value| text.contains(value))
}

fn json_text(download: &CloudRequest) -> String {
    serde_json::to_string(download).unwrap_or_default()
}

fn video_path(file: &CachedFile) -> String {
    file.folder.iter().flatten().map(String::as_str).chain([file.filename.as_str()]).collect::<Vec<_>>().join("/")
}

fn sorted_videos(files: &[CachedFile]) -> Vec<&CachedFile> {
    let mut videos: Vec<&CachedFile> = files.iter().filter(|file| is_video(&file.filename)).collect();
    videos.sort_by_key(|video| std::cmp::Reverse(video.size));
    videos
}

fn target_video<'a>(
    videos: &[&'a CachedFile],
    target_file_name: &str,
    file_index: Option<i64>,
) -> Option<&'a CachedFile> {
    file_index
        .and_then(|_| videos.iter().find(|video| same_filename(&video_path(video), target_file_name)).copied())
        .or_else(|| videos.first().copied())
}

fn status_downloading(download: &CloudRequest) -> bool {
    matches!(download.status.as_deref(), Some("created" | "downloading" | "queued"))
}

fn status_error(download: &CloudRequest) -> bool {
    matches!(download.status.as_deref(), Some("error" | "canceled"))
}

fn status_ready(download: &CloudRequest) -> bool {
    download.status.as_deref() == Some("downloaded")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn string_error(message: &str) -> MochError {
        debrid::Error::api(Some(400), json!({ "error": message })).into()
    }

    fn download(status: &str) -> CloudRequest {
        CloudRequest { status: Some(status.to_owned()), ..CloudRequest::default() }
    }

    fn file(folder: Option<&[&str]>, filename: &str, size: i64) -> CachedFile {
        CachedFile {
            filename: filename.to_owned(),
            folder: folder.map(|parts| parts.iter().map(|part| (*part).to_owned()).collect()),
            size,
            url: format!("https://cdn/{filename}"),
        }
    }

    fn params() -> ResolveParams {
        ResolveParams {
            moch_key: KEY.to_owned(),
            api_key: "key".to_owned(),
            info_hash: "abc".to_owned(),
            file_index: Some(1),
            cached_entry_info: String::new(),
            ip: None,
            host: String::new(),
            is_browser: false,
        }
    }

    #[test]
    fn downloading_statuses() {
        assert!(["created", "downloading", "queued"].iter().all(|status| status_downloading(&download(status))));
        assert!(!status_downloading(&download("downloaded")));
        assert!(!status_downloading(&CloudRequest::default()));
    }

    #[test]
    fn error_statuses() {
        assert!(status_error(&download("error")));
        assert!(status_error(&download("canceled")));
        assert!(!status_error(&download("queued")));
    }

    #[test]
    fn ready_status() {
        assert!(status_ready(&download("downloaded")));
        assert!(!status_ready(&download("created")));
    }

    #[test]
    fn noauth_and_unauthorized_map_to_bad_token() {
        assert_eq!(common_error(&string_error("NOAUTH")), Some(CommonError::BadToken));
        assert_eq!(common_error(&string_error("Unauthorized request")), Some(CommonError::BadToken));
    }

    #[test]
    fn not_premium_maps_to_access_denied() {
        assert_eq!(common_error(&string_error("Account is not premium")), Some(CommonError::AccessDenied));
    }

    #[test]
    fn unrelated_errors_are_not_common() {
        assert_eq!(common_error(&string_error("something else")), None);
    }

    #[test]
    fn plain_message_errors_are_classified_by_text() {
        assert_eq!(common_error(&MochError::message("NOAUTH")), Some(CommonError::BadToken));
    }

    #[test]
    fn limit_messages_map_to_limits_exceeded_video() {
        for message in ["You have a maximum of 25 active downloads", "Fair use limit reached"] {
            let result = static_for_error(&string_error(message), &params()).expect("static video");
            assert_eq!(result, Resolved::Message(StaticResponse::LimitsExceeded));
        }
    }

    #[test]
    fn unsupported_link_maps_to_failed_download_video() {
        let result = static_for_error(&string_error("Unsupported link for direct download"), &params()).expect("video");
        assert_eq!(result, Resolved::Message(StaticResponse::FailedDownload));
    }

    #[test]
    fn access_denied_maps_to_failed_access_video() {
        let result = static_for_error(&string_error("not premium"), &params()).expect("static video");
        assert_eq!(result, Resolved::Message(StaticResponse::FailedAccess));
    }

    #[test]
    fn unknown_error_is_wrapped_with_json_quoted_message() {
        let error = static_for_error(&string_error("boom"), &params()).expect_err("rejected");
        assert_eq!(error.to_string(), "Failed Offcloud adding torrent \"boom\"");
    }

    #[test]
    fn path_includes_folder_parts() {
        assert_eq!(video_path(&file(Some(&["a", "b"]), "c.mkv", 1)), "a/b/c.mkv");
        assert_eq!(video_path(&file(None, "c.mkv", 1)), "c.mkv");
    }

    #[test]
    fn largest_video_is_default_target() {
        let files = vec![file(None, "a.mkv", 1), file(None, "b.txt", 99), file(None, "c.mkv", 5)];
        let videos = sorted_videos(&files);
        assert_eq!(target_video(&videos, "", None).map(|video| video.filename.as_str()), Some("c.mkv"));
    }

    #[test]
    fn indexed_target_matches_folder_path_suffix() {
        let files = vec![file(Some(&["d"]), "a.mkv", 1), file(Some(&["d"]), "c.mkv", 5)];
        let videos = sorted_videos(&files);
        assert_eq!(target_video(&videos, "d/a.mkv", Some(0)).map(|video| video.filename.as_str()), Some("a.mkv"));
    }

    #[test]
    fn unmatched_indexed_target_falls_back_to_largest() {
        let files = vec![file(None, "a.mkv", 1), file(None, "c.mkv", 5)];
        let videos = sorted_videos(&files);
        assert_eq!(target_video(&videos, "zzz.mkv", Some(0)).map(|video| video.filename.as_str()), Some("c.mkv"));
    }

    #[test]
    fn download_json_keeps_unknown_fields() {
        let mut request = download("weird");
        request.rest.insert("requestId".to_owned(), json!("r1"));
        assert_eq!(json_text(&request), "{\"status\":\"weird\",\"requestId\":\"r1\"}");
    }
}
