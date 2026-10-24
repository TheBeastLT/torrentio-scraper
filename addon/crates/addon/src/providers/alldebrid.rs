use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat};
use debrid::alldebrid::{Auth, Client, File, Magnet};
use serde_json::Value;

use super::{
    CachedStreams, CommonError, Context, Moch, MochError, MochResult, ResolveParams, Resolved,
    helper::{encode_uri_component, same_filename},
    static_videos::StaticResponse,
    support::{
        CachedName, Rule, adding_error, build_cached, error_text, index_text, info_hashes, quoted, resolve_target,
        static_or_err,
    },
};
use crate::{
    domain::config::Config,
    domain::extension::{is_archive, is_video},
    domain::models::{CatalogMeta, ItemMeta, Video, VideoStream},
    domain::stream::Stream,
    infrastructure::magnet::magnet_link,
};

const KEY: &str = "alldebrid";
const BAD_TOKEN: &[&str] = &["AUTH_BAD_APIKEY"];
const ACCESS_DENIED: &[&str] =
    &["MUST_BE_PREMIUM", "MAGNET_MUST_BE_PREMIUM", "FREE_TRIAL_LIMIT_REACHED", "AUTH_USER_BANNED"];
const BLOCKED_ACCESS: &[&str] = &["AUTH_BLOCKED"];
const UNKNOWN_MAGNET: &[&str] = &["MAGNET_INVALID_ID"];
const FAILED_DOWNLOAD: &[&str] = &["MAGNET_INVALID_FILE", "MAGNET_PROCESSING_COOLDOWN", "MAGNET_PROCESSING_FAILED"];
const TOO_MANY_TORRENTS: &[&str] = &["MAGNET_TOO_MANY"];
const LIMIT_EXCEEDED: &[&str] = &["MAGNET_TOO_MANY_ACTIVE"];

struct AllDebrid {
    context: Arc<Context>,
    client: Client,
}

pub fn build(context: Arc<Context>) -> Box<dyn Moch> {
    let client = Client::new(context.http.clone());
    Box::new(AllDebrid { context, client })
}

#[async_trait]
impl Moch for AllDebrid {
    async fn cached_streams(
        &self,
        streams: &[Stream],
        api_key: &str,
        _ip: Option<&str>,
    ) -> MochResult<Option<CachedStreams>> {
        let available = self.context.cache.moch_cached_availability(KEY, &info_hashes(streams)).await;
        let cached = build_cached(api_key, streams, CachedName::Filename, |_, _, info_hash| {
            available.get(info_hash).is_some_and(is_cached)
        });
        Ok(Some(cached))
    }

    async fn catalog(&self, api_key: &str, _catalog_id: &str, config: &Config) -> MochResult<Vec<CatalogMeta>> {
        if config.skip() > 0 {
            return Ok(Vec::new());
        }
        let auth = Auth { api_key, ip: config.ip() };
        let magnets = self.client.magnets(auth).await?;
        Ok(magnets
            .into_iter()
            .filter(|magnet| magnet.status_code.is_some_and(status_ready))
            .map(|magnet| CatalogMeta {
                id: format!("{KEY}:{}", magnet.id),
                kind: "other".to_owned(),
                name: magnet.filename,
            })
            .collect())
    }

    async fn item_meta(&self, item_id: &str, api_key: &str, ip: Option<&str>) -> MochResult<ItemMeta> {
        let id: i64 = item_id.parse().map_err(|_| CommonError::NotFound)?;
        let magnet = self
            .client
            .magnet(Auth { api_key, ip }, id)
            .await
            .map_err(|error| meta_error(error.into()))?
            .ok_or(CommonError::NotFound)?;
        let hash = magnet.hash.to_lowercase();
        let videos = magnet
            .links
            .iter()
            .filter(|link| is_video(&link.filename))
            .enumerate()
            .map(|(index, link)| Video {
                id: format!("{KEY}:{}:{index}", magnet.id),
                title: link.filename.clone(),
                released: DateTime::from_timestamp_millis(magnet.upload_date * 1000 - index as i64)
                    .map(|released| released.to_rfc3339_opts(SecondsFormat::Millis, true)),
                streams: vec![VideoStream {
                    url: format!("{api_key}/{hash}/{}/{index}", encode_uri_component(&link.filename)),
                    behavior_hints: None,
                }],
                ..Video::default()
            })
            .collect();
        Ok(ItemMeta {
            id: format!("{KEY}:{}", magnet.id),
            kind: "other".to_owned(),
            name: magnet.filename,
            info_hash: Some(hash),
            videos,
            ..ItemMeta::default()
        })
    }

    async fn resolve(&self, params: &ResolveParams) -> MochResult<Resolved> {
        let auth = Auth { api_key: &params.api_key, ip: params.ip.as_deref() };
        let result = match self.resolve_inner(auth, params).await {
            Err(error) if has_code(&error, TOO_MANY_TORRENTS) => {
                tracing::info!(
                    moch = "alldebrid",
                    info_hash = %params.info_hash,
                    file_index = %index_text(params.file_index),
                    "Deleting and retrying adding to AllDebrid"
                );
                self.delete_and_retry(auth, params, error).await
            }
            other => other,
        };
        result.or_else(|error| static_for_error(&error, params))
    }

    fn to_common_error(&self, error: &MochError) -> Option<CommonError> {
        common_error(error)
    }
}

impl AllDebrid {
    async fn resolve_inner(&self, auth: Auth<'_>, params: &ResolveParams) -> MochResult<Resolved> {
        let info_hash = params.info_hash.as_str();
        let label = index_text(params.file_index);
        let torrent = self.create_torrent(auth, info_hash).await?;
        let Some(torrent) = torrent else {
            return Err(MochError::message("Failed AllDebrid adding torrent undefined"));
        };
        if let Some(code) = torrent.status_code {
            if status_ready(code) {
                return self.unrestrict_link(auth, &torrent, &params.cached_entry_info, params.file_index).await;
            }
            if status_downloading(code) {
                tracing::info!(moch = "alldebrid", %info_hash, file_index = %label, "Downloading to AllDebrid");
                self.remove_availability(info_hash);
                return Ok(StaticResponse::Downloading.into());
            }
            if status_too_big_entry(code) {
                tracing::info!(moch = "alldebrid", %info_hash, file_index = %label, "Torrent too big for AllDebrid");
                return Ok(StaticResponse::FailedTooBig.into());
            }
            if status_error(code) {
                tracing::info!(moch = "alldebrid", %info_hash, file_index = %label, "Retrying downloading to AllDebrid");
                return self.retry_create_torrent(auth, params).await;
            }
        }
        Err(adding_error("AllDebrid", serde_json::to_string(&torrent).unwrap_or_default()))
    }

    async fn retry_create_torrent(&self, auth: Auth<'_>, params: &ResolveParams) -> MochResult<Resolved> {
        let torrent = self.create_torrent(auth, &params.info_hash).await?;
        match torrent {
            Some(torrent) if torrent.status_code.is_some_and(status_ready) => {
                self.unrestrict_link(auth, &torrent, &params.cached_entry_info, params.file_index).await
            }
            _ => Ok(StaticResponse::FailedDownload.into()),
        }
    }

    async fn delete_and_retry(&self, auth: Auth<'_>, params: &ResolveParams, error: MochError) -> MochResult<Resolved> {
        let magnets = self.client.magnets(auth).await?;
        let Some(last) = magnets.last() else {
            return Err(error);
        };
        self.client.delete_magnet(auth, last.id).await?;
        self.retry_create_torrent(auth, params).await
    }

    async fn create_torrent(&self, auth: Auth<'_>, info_hash: &str) -> MochResult<Option<Magnet>> {
        let magnet = magnet_link(self.context.repository.as_ref(), info_hash).await;
        let id = self.client.upload_magnet(auth, &magnet).await?;
        Ok(self.client.magnet(auth, id).await?)
    }

    async fn unrestrict_link(
        &self,
        auth: Auth<'_>,
        torrent: &Magnet,
        target_file_name: &str,
        file_index: Option<i64>,
    ) -> MochResult<Resolved> {
        let files = self.client.files(auth, torrent.id).await?;
        let videos = sorted_videos(files);
        let target = target_video(&videos, target_file_name, file_index);
        if target.is_none() && videos.iter().all(|video| is_archive(&video.n)) {
            tracing::info!(
                moch = "alldebrid",
                info_hash = %torrent.hash,
                file_name = %target_file_name,
                "Only AllDebrid archive is available"
            );
            return Ok(StaticResponse::FailedRar.into());
        }
        let Some(link) = target.map(|video| video.l.as_str()).filter(|link| !link.is_empty()) else {
            return Err(MochError::message(format!(
                "No AllDebrid links found for [{}] {target_file_name}",
                torrent.hash
            )));
        };
        let unlocked = self.client.unlock(auth, link).await?;
        self.cache_availability(&torrent.hash.to_lowercase());
        Ok(Resolved::Url(unlocked))
    }

    fn cache_availability(&self, info_hash: &str) {
        self.context.cache.cache_moch_availability(KEY, info_hash, None);
    }

    fn remove_availability(&self, info_hash: &str) {
        self.context.cache.remove_moch_availability(KEY, info_hash);
    }
}

fn static_for_error(error: &MochError, params: &ResolveParams) -> MochResult<Resolved> {
    let code = error_code(error);
    let in_codes = |codes: &[&str]| code.is_some_and(|code| codes.contains(&code));
    let rules = [
        Rule::new(
            in_codes(ACCESS_DENIED) || in_codes(BAD_TOKEN),
            StaticResponse::FailedAccess,
            "Access denied to AllDebrid {}",
        ),
        Rule::new(in_codes(BLOCKED_ACCESS), StaticResponse::BlockedAccess, "Access blocked to AllDebrid {}"),
        Rule::new(in_codes(FAILED_DOWNLOAD), StaticResponse::FailedOpening, "Failed opening torrent in AllDebrid {}"),
        Rule::new(
            in_codes(LIMIT_EXCEEDED) || in_codes(TOO_MANY_TORRENTS),
            StaticResponse::LimitsExceeded,
            "Limits exceeded in AllDebrid {}",
        ),
    ];
    static_or_err(&rules, &resolve_target(params), || adding_error("AllDebrid", quoted(alldebrid_text(error))))
}

fn meta_error(error: MochError) -> MochError {
    if has_code(&error, UNKNOWN_MAGNET) { CommonError::NotFound.into() } else { error }
}

fn common_error(error: &MochError) -> Option<CommonError> {
    match error {
        MochError::Common(common) => Some(*common),
        MochError::Provider(_) => {
            let code = error_code(error)?;
            if BAD_TOKEN.contains(&code) {
                Some(CommonError::BadToken)
            } else if ACCESS_DENIED.contains(&code) {
                Some(CommonError::AccessDenied)
            } else if BLOCKED_ACCESS.contains(&code) {
                Some(CommonError::AccessBlocked)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn error_code(error: &MochError) -> Option<&str> {
    error.provider().and_then(debrid::alldebrid::error_code)
}

fn has_code(error: &MochError, codes: &[&str]) -> bool {
    error_code(error).is_some_and(|code| codes.contains(&code))
}

fn alldebrid_text(error: &MochError) -> String {
    error_text(error, debrid::alldebrid::error_message)
}

fn is_cached(value: &Value) -> bool {
    value.get("cached").and_then(Value::as_bool) == Some(true)
}

fn sorted_videos(files: Vec<File>) -> Vec<File> {
    let mut videos: Vec<File> = files.into_iter().filter(|file| is_video(&file.n)).collect();
    videos.sort_by_key(|video| std::cmp::Reverse(video.s));
    videos
}

fn target_video<'a>(videos: &'a [File], target_file_name: &str, file_index: Option<i64>) -> Option<&'a File> {
    file_index
        .and_then(|_| videos.iter().find(|video| same_filename(target_file_name, &video.n)))
        .or_else(|| videos.first())
}

fn status_error(status_code: i64) -> bool {
    status_code > 4
}

fn status_downloading(status_code: i64) -> bool {
    (0..=3).contains(&status_code)
}

fn status_ready(status_code: i64) -> bool {
    status_code == 4
}

fn status_too_big_entry(status_code: i64) -> bool {
    status_code == 8
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn provider_error(code: &str) -> MochError {
        debrid::Error::api(Some(200), json!({ "code": code, "message": "text" })).into()
    }

    fn file(name: &str, size: i64) -> File {
        File { n: name.to_owned(), s: size, l: format!("link-{name}") }
    }

    #[test]
    fn ready_status_is_four() {
        assert!(status_ready(4));
        assert!(!status_ready(5));
    }

    #[test]
    fn downloading_statuses_are_zero_to_three() {
        assert!((0..=3).all(status_downloading));
        assert!(!status_downloading(4));
        assert!(!status_downloading(-1));
    }

    #[test]
    fn error_statuses_are_above_four() {
        assert!(status_error(5));
        assert!(!status_error(4));
    }

    #[test]
    fn too_big_status_is_eight() {
        assert!(status_too_big_entry(8));
        assert!(!status_too_big_entry(7));
    }

    #[test]
    fn bad_apikey_maps_to_bad_token() {
        assert_eq!(common_error(&provider_error("AUTH_BAD_APIKEY")), Some(CommonError::BadToken));
    }

    #[test]
    fn premium_and_ban_codes_map_to_access_denied() {
        for code in ACCESS_DENIED {
            assert_eq!(common_error(&provider_error(code)), Some(CommonError::AccessDenied));
        }
    }

    #[test]
    fn blocked_code_maps_to_access_blocked() {
        assert_eq!(common_error(&provider_error("AUTH_BLOCKED")), Some(CommonError::AccessBlocked));
    }

    #[test]
    fn other_codes_are_not_common_errors() {
        assert_eq!(common_error(&provider_error("MAGNET_TOO_MANY")), None);
        assert_eq!(common_error(&MochError::message("AUTH_BAD_APIKEY")), None);
    }

    #[test]
    fn common_errors_pass_through() {
        assert_eq!(common_error(&CommonError::NotFound.into()), Some(CommonError::NotFound));
    }

    #[test]
    fn largest_video_is_default_target() {
        let videos = sorted_videos(vec![file("a.mkv", 10), file("b.nfo", 99), file("c.mkv", 20)]);
        assert_eq!(target_video(&videos, "", None).map(|video| video.n.as_str()), Some("c.mkv"));
    }

    #[test]
    fn indexed_target_matches_when_target_ends_with_video_name() {
        let videos = sorted_videos(vec![file("a.mkv", 10), file("c.mkv", 20)]);
        assert_eq!(target_video(&videos, "x/a.mkv", Some(0)).map(|video| video.n.as_str()), Some("a.mkv"));
    }

    #[test]
    fn unmatched_indexed_target_falls_back_to_largest() {
        let videos = sorted_videos(vec![file("a.mkv", 10), file("c.mkv", 20)]);
        assert_eq!(target_video(&videos, "missing.mkv", Some(3)).map(|video| video.n.as_str()), Some("c.mkv"));
    }

    #[test]
    fn no_videos_means_no_target() {
        assert!(target_video(&sorted_videos(vec![file("a.nfo", 1)]), "", None).is_none());
    }

    #[test]
    fn failed_download_codes_map_to_failed_opening_video() {
        let params = params();
        let result = static_for_error(&provider_error("MAGNET_PROCESSING_FAILED"), &params).expect("static video");
        assert_eq!(result, Resolved::Message(StaticResponse::FailedOpening));
    }

    #[test]
    fn too_many_active_maps_to_limits_exceeded_video() {
        let result = static_for_error(&provider_error("MAGNET_TOO_MANY_ACTIVE"), &params()).expect("static video");
        assert_eq!(result, Resolved::Message(StaticResponse::LimitsExceeded));
    }

    #[test]
    fn blocked_maps_to_blocked_access_video() {
        let result = static_for_error(&provider_error("AUTH_BLOCKED"), &params()).expect("static video");
        assert_eq!(result, Resolved::Message(StaticResponse::BlockedAccess));
    }

    #[test]
    fn unknown_error_is_wrapped_with_json_quoted_message() {
        let error = static_for_error(&provider_error("OTHER"), &params()).expect_err("rejected");
        assert_eq!(error.to_string(), "Failed AllDebrid adding torrent \"text\"");
    }

    #[test]
    fn cached_flag_requires_true() {
        assert!(is_cached(&json!({ "cached": true })));
        assert!(!is_cached(&json!({ "cached": false })));
        assert!(!is_cached(&json!({})));
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
    fn unknown_magnet_on_meta_is_not_found() {
        assert!(matches!(meta_error(provider_error("MAGNET_INVALID_ID")), MochError::Common(CommonError::NotFound)));
        assert!(matches!(meta_error(provider_error("AUTH_BAD_APIKEY")), MochError::Provider(_)));
    }
}
