use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat};
use debrid::debridlink::{Client, File, Torrent};
use serde_json::Value;

use super::{
    CachedStreams, CommonError, Context, Moch, MochError, MochResult, ResolveParams, Resolved,
    static_videos::StaticResponse,
    support::{
        CachedName, Rule, adding_error, build_cached, index_text, is_truthy, padded_info_hashes, quoted,
        resolve_target, static_or_err,
    },
};
use crate::{
    domain::config::Config,
    domain::extension::{is_archive, is_video},
    domain::models::{CatalogMeta, ItemMeta, Video, VideoStream},
    domain::stream::Stream,
    infrastructure::magnet::magnet_link,
};

const KEY: &str = "debridlink";
const ACCESS_DENIED: &[&str] = &["badToken", "accountLocked", "unverifiedEmail"];
const LIMITS_EXCEEDED: &[&str] = &[
    "freeServerOverload",
    "maxTorrent",
    "maxLink",
    "maxLinkHost",
    "maxData",
    "maxDataHost",
    "maxTransfer",
    "floodDetected",
];
const TORRENT_TOO_BIG: &str = "torrentTooBig";
const FAILED_OPENING: &str = "notAddTorrent";
const BAD_TOKEN: &str = "badToken";

struct DebridLink {
    context: Arc<Context>,
    client: Client,
}

enum Unrestricted {
    Link(String),
    Archive,
}

pub fn build(context: Arc<Context>) -> Box<dyn Moch> {
    let client = Client::new(context.http.clone());
    Box::new(DebridLink { context, client })
}

#[async_trait]
impl Moch for DebridLink {
    async fn cached_streams(
        &self,
        streams: &[Stream],
        api_key: &str,
        _ip: Option<&str>,
    ) -> MochResult<Option<CachedStreams>> {
        let available = self.context.cache.moch_cached_availability(KEY, &padded_info_hashes(streams)).await;
        let cached = build_cached(api_key, streams, CachedName::Null, |_, _, info_hash| {
            available.get(info_hash).and_then(|value| value.get("cached")).is_some_and(is_truthy)
        });
        Ok(Some(cached))
    }

    async fn catalog(&self, api_key: &str, _catalog_id: &str, config: &Config) -> MochResult<Vec<CatalogMeta>> {
        if config.skip() > 0 {
            return Ok(Vec::new());
        }
        let torrents = self.client.list(api_key, None, None).await?;
        Ok(torrents
            .into_iter()
            .filter(status_ready)
            .map(|torrent| CatalogMeta {
                id: format!("{KEY}:{}", torrent.id),
                kind: "other".to_owned(),
                name: torrent.name,
            })
            .collect())
    }

    async fn item_meta(&self, item_id: &str, api_key: &str, ip: Option<&str>) -> MochResult<ItemMeta> {
        let torrent =
            self.client.list(api_key, Some(item_id), ip).await?.into_iter().next().ok_or(CommonError::NotFound)?;
        let videos = torrent
            .files
            .iter()
            .filter(|file| is_video(&file.name))
            .enumerate()
            .map(|(index, file)| Video {
                id: format!("{KEY}:{}:{index}", torrent.id),
                title: file.name.clone(),
                released: released(torrent.created, index),
                streams: vec![VideoStream { url: file.download_url.clone().unwrap_or_default(), behavior_hints: None }],
                ..Video::default()
            })
            .collect();
        Ok(ItemMeta {
            id: format!("{KEY}:{}", torrent.id),
            kind: "other".to_owned(),
            name: torrent.name,
            info_hash: Some(torrent.hash_string.to_lowercase()),
            videos,
            ..ItemMeta::default()
        })
    }

    async fn resolve(&self, params: &ResolveParams) -> MochResult<Resolved> {
        self.resolve_inner(params).await.or_else(|error| static_for_error(&error, params))
    }

    fn to_common_error(&self, error: &MochError) -> Option<CommonError> {
        common_error(error)
    }
}

impl DebridLink {
    async fn resolve_inner(&self, params: &ResolveParams) -> MochResult<Resolved> {
        let info_hash = params.info_hash.as_str();
        let ip = params.ip.as_deref();
        let torrent = match self.find_torrent(&params.api_key, info_hash, ip).await? {
            Some(torrent) => Some(torrent),
            None => self.create_torrent(&params.api_key, info_hash, ip).await?,
        };
        let Some(torrent) = torrent else {
            return Err(MochError::message("Failed DebridLink adding torrent undefined"));
        };
        if status_ready(&torrent) {
            return match unrestrict_link(&torrent, params.file_index)? {
                Unrestricted::Link(link) => {
                    self.context.cache.cache_moch_availability(KEY, &torrent.hash_string.to_lowercase(), None);
                    Ok(Resolved::Url(link))
                }
                Unrestricted::Archive => {
                    tracing::info!(
                        moch = "debridlink",
                        info_hash = %torrent.hash_string,
                        file_index = %index_text(params.file_index),
                        "Only DebridLink archive is available"
                    );
                    Ok(StaticResponse::FailedRar.into())
                }
            };
        }
        if status_downloading(&torrent) {
            tracing::info!(moch = "debridlink", %info_hash, file_index = %index_text(params.file_index), "Downloading to DebridLink");
            self.context.cache.remove_moch_availability(KEY, info_hash);
            return Ok(StaticResponse::Downloading.into());
        }
        Err(adding_error("DebridLink", serde_json::to_string(&torrent).unwrap_or_default()))
    }

    async fn find_torrent(&self, api_key: &str, info_hash: &str, ip: Option<&str>) -> MochResult<Option<Torrent>> {
        let torrents = self.client.list(api_key, None, ip).await?;
        Ok(torrents.into_iter().find(|torrent| torrent.hash_string.to_lowercase() == info_hash))
    }

    async fn create_torrent(&self, api_key: &str, info_hash: &str, ip: Option<&str>) -> MochResult<Option<Torrent>> {
        let magnet = magnet_link(self.context.repository.as_ref(), info_hash).await;
        Ok(self.client.add_torrent(api_key, &magnet, ip).await?)
    }
}

fn unrestrict_link(torrent: &Torrent, file_index: Option<i64>) -> MochResult<Unrestricted> {
    let target = select_file(torrent, file_index);
    if target.is_none() && torrent.files.iter().all(|file| file.download_url.as_deref().is_some_and(is_archive)) {
        return Ok(Unrestricted::Archive);
    }
    match target.and_then(|file| file.download_url.as_deref()).filter(|url| !url.is_empty()) {
        Some(url) => Ok(Unrestricted::Link(url.to_owned())),
        None => Err(MochError::message(format!(
            "No DebridLink links found for index {} in: {}",
            index_text(file_index),
            serde_json::to_string(torrent).unwrap_or_default()
        ))),
    }
}

fn select_file(torrent: &Torrent, file_index: Option<i64>) -> Option<&File> {
    if let Some(index) = file_index {
        return usize::try_from(index).ok().and_then(|index| torrent.files.get(index));
    }
    let mut complete: Vec<&File> = torrent.files.iter().filter(|file| is_complete(file.download_percent)).collect();
    complete.sort_by(|a, b| b.size.total_cmp(&a.size));
    complete.first().copied()
}

fn common_error(error: &MochError) -> Option<CommonError> {
    match error {
        MochError::Common(common) => Some(*common),
        _ if provider_code(error) == Some(BAD_TOKEN) => Some(CommonError::BadToken),
        _ => None,
    }
}

fn static_for_error(error: &MochError, params: &ResolveParams) -> MochResult<Resolved> {
    let code = provider_code(error);
    let in_codes = |codes: &[&str]| code.is_some_and(|code| codes.contains(&code));
    let rules = [
        Rule::new(in_codes(ACCESS_DENIED), StaticResponse::FailedAccess, "Access denied to DebridLink {}"),
        Rule::new(in_codes(LIMITS_EXCEEDED), StaticResponse::LimitsExceeded, "Limits exceeded in DebridLink {}"),
        Rule::new(in_codes(&[TORRENT_TOO_BIG]), StaticResponse::FailedTooBig, "Torrent too big for DebridLink {}"),
        Rule::new(in_codes(&[FAILED_OPENING]), StaticResponse::FailedOpening, "Failed DebridLink opening torrent {}"),
    ];
    static_or_err(&rules, &resolve_target(params), || adding_error("DebridLink", quoted(error_message(error))))
}

fn provider_code(error: &MochError) -> Option<&str> {
    error.provider().and_then(debrid::Error::code)
}

fn error_message(error: &MochError) -> String {
    match error.provider() {
        Some(provider) => provider
            .code()
            .or_else(|| provider.body().and_then(|body| body.get("message")).and_then(Value::as_str))
            .map_or_else(|| provider.to_string(), str::to_owned),
        None => error.to_string(),
    }
}

fn released(created: f64, index: usize) -> Option<String> {
    let millis = (created * 1000.0) as i64 - index as i64;
    DateTime::from_timestamp_millis(millis).map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn is_complete(percent: Option<f64>) -> bool {
    percent.is_some_and(|percent| percent >= 100.0)
}

fn status_ready(torrent: &Torrent) -> bool {
    is_complete(torrent.download_percent)
}

fn status_downloading(torrent: &Torrent) -> bool {
    torrent.download_percent.is_some_and(|percent| percent < 100.0)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn api_error(code: &str) -> MochError {
        debrid::Error::api(Some(400), json!({ "error": code })).into()
    }

    fn params() -> ResolveParams {
        ResolveParams {
            moch_key: KEY.to_owned(),
            api_key: "key".to_owned(),
            info_hash: "abc".to_owned(),
            file_index: None,
            cached_entry_info: String::new(),
            ip: None,
            host: String::new(),
            is_browser: false,
        }
    }

    fn file(name: &str, size: f64, percent: f64) -> File {
        File {
            name: name.to_owned(),
            download_url: Some(format!("http://dl/{name}")),
            download_percent: Some(percent),
            size,
        }
    }

    fn torrent(files: Vec<File>) -> Torrent {
        Torrent {
            id: "t1".to_owned(),
            hash_string: "ABC".to_owned(),
            download_percent: Some(100.0),
            files,
            ..Torrent::default()
        }
    }

    fn link(result: MochResult<Unrestricted>) -> Option<String> {
        match result {
            Ok(Unrestricted::Link(link)) => Some(link),
            _ => None,
        }
    }

    #[test]
    fn bad_token_code_is_common_bad_token() {
        assert_eq!(common_error(&api_error("badToken")), Some(CommonError::BadToken));
        assert_eq!(common_error(&api_error("maxLink")), None);
    }

    #[test]
    fn access_denied_codes_resolve_to_failed_access() {
        for code in ["badToken", "accountLocked", "unverifiedEmail"] {
            let url = static_for_error(&api_error(code), &params()).expect("static video");
            assert_eq!(url, Resolved::Message(StaticResponse::FailedAccess));
        }
    }

    #[test]
    fn limit_codes_resolve_to_limits_exceeded() {
        for code in [
            "freeServerOverload",
            "maxTorrent",
            "maxLink",
            "maxLinkHost",
            "maxData",
            "maxDataHost",
            "maxTransfer",
            "floodDetected",
        ] {
            let url = static_for_error(&api_error(code), &params()).expect("static video");
            assert_eq!(url, Resolved::Message(StaticResponse::LimitsExceeded));
        }
    }

    #[test]
    fn too_big_code_resolves_to_failed_too_big() {
        let url = static_for_error(&api_error("torrentTooBig"), &params()).expect("static video");
        assert_eq!(url, Resolved::Message(StaticResponse::FailedTooBig));
    }

    #[test]
    fn not_add_torrent_code_resolves_to_failed_opening() {
        let url = static_for_error(&api_error("notAddTorrent"), &params()).expect("static video");
        assert_eq!(url, Resolved::Message(StaticResponse::FailedOpening));
    }

    #[test]
    fn unknown_code_is_rejected_with_json_message() {
        let error = static_for_error(&api_error("weird"), &params()).expect_err("rejection");
        assert_eq!(error.to_string(), "Failed DebridLink adding torrent \"weird\"");
    }

    #[test]
    fn plain_message_with_known_code_text_is_not_classified() {
        assert!(static_for_error(&MochError::message("maxLink"), &params()).is_err());
    }

    #[test]
    fn download_percent_drives_status() {
        let mut item = torrent(Vec::new());
        assert!(status_ready(&item) && !status_downloading(&item));
        item.download_percent = Some(42.0);
        assert!(!status_ready(&item) && status_downloading(&item));
        item.download_percent = None;
        assert!(!status_ready(&item) && !status_downloading(&item));
    }

    #[test]
    fn file_index_selects_file_by_position() {
        let item = torrent(vec![file("a.mkv", 1.0, 100.0), file("b.mkv", 9.0, 100.0)]);
        assert_eq!(link(unrestrict_link(&item, Some(0))), Some("http://dl/a.mkv".to_owned()));
    }

    #[test]
    fn missing_file_index_selects_largest_complete_file() {
        let item = torrent(vec![file("a.mkv", 1.0, 100.0), file("b.mkv", 9.0, 50.0), file("c.mkv", 5.0, 100.0)]);
        assert_eq!(link(unrestrict_link(&item, None)), Some("http://dl/c.mkv".to_owned()));
    }

    #[test]
    fn out_of_range_index_with_archive_only_files_is_archive() {
        let item = torrent(vec![file("a.rar", 1.0, 100.0)]);
        assert!(matches!(unrestrict_link(&item, Some(3)), Ok(Unrestricted::Archive)));
    }

    #[test]
    fn out_of_range_index_with_other_files_is_an_error() {
        let item = torrent(vec![file("a.mkv", 1.0, 100.0)]);
        let error = unrestrict_link(&item, Some(3)).err().expect("rejection");
        assert!(error.to_string().starts_with("No DebridLink links found for index 3 in: "));
    }

    #[test]
    fn file_without_download_url_is_an_error() {
        let mut item = torrent(vec![file("a.mkv", 1.0, 100.0)]);
        item.files[0].download_url = None;
        assert!(unrestrict_link(&item, Some(0)).is_err());
    }

    #[test]
    fn released_subtracts_index_milliseconds() {
        assert_eq!(released(1_700_000_000.0, 2), Some("2023-11-14T22:13:19.998Z".to_owned()));
    }
}
