use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use debrid::deepbrid::{Client, Torrent};
use moka::future::Cache as Moka;

use super::{
    CachedStreams, CommonError, Context, Moch, MochError, MochResult, ResolveParams, Resolved,
    helper::same_filename,
    static_videos::StaticResponse,
    support::{
        CachedName, Rule, adding_error, build_cached, error_text, index_text, is_truthy, padded_info_hashes, quoted,
        resolve_target, static_or_err,
    },
};
use crate::{
    domain::config::Config,
    domain::extension::{is_archive, is_video},
    domain::models::{CatalogMeta, ItemMeta},
    domain::stream::Stream,
    infrastructure::magnet::magnet_link,
};

const KEY: &str = "deepbrid";
const FAILED_STATUSES: &[&str] = &["error", "dead", "magnet_error", "virus"];
const DOWNLOADED: &str = "downloaded";
const NOT_PREMIUM: i64 = 2;
const READY_WAIT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_secs(2);
// Deepbrid does not expose info hashes, so torrents added here are remembered per api key to avoid duplicates.
const TORRENT_IDS_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const TORRENT_IDS_CAPACITY: u64 = 100_000;

struct Deepbrid {
    context: Arc<Context>,
    client: Client,
    torrent_ids: Moka<String, String>,
}

pub fn build(context: Arc<Context>) -> Box<dyn Moch> {
    let client = Client::new(context.http.clone());
    let torrent_ids = Moka::builder().max_capacity(TORRENT_IDS_CAPACITY).time_to_live(TORRENT_IDS_TTL).build();
    Box::new(Deepbrid { context, client, torrent_ids })
}

#[async_trait]
impl Moch for Deepbrid {
    // Deepbrid has no instant availability endpoint: torrents count as cached once a resolve succeeded.
    async fn cached_streams(
        &self,
        streams: &[Stream],
        api_key: &str,
        _ip: Option<&str>,
    ) -> MochResult<Option<CachedStreams>> {
        let available = self.context.cache.moch_cached_availability(KEY, &padded_info_hashes(streams)).await;
        let cached = build_cached(api_key, streams, CachedName::Filename, |_, _, info_hash| {
            available.get(info_hash).and_then(|value| value.get("cached")).is_some_and(is_truthy)
        });
        Ok(Some(cached))
    }

    async fn catalog(&self, _api_key: &str, _catalog_id: &str, _config: &Config) -> MochResult<Vec<CatalogMeta>> {
        Ok(Vec::new())
    }

    async fn item_meta(&self, _item_id: &str, _api_key: &str, _ip: Option<&str>) -> MochResult<ItemMeta> {
        Err(CommonError::NotFound.into())
    }

    async fn resolve(&self, params: &ResolveParams) -> MochResult<Resolved> {
        self.resolve_inner(params).await.or_else(|error| static_for_error(&error, params))
    }

    fn to_common_error(&self, error: &MochError) -> Option<CommonError> {
        common_error(error)
    }
}

impl Deepbrid {
    async fn resolve_inner(&self, params: &ResolveParams) -> MochResult<Resolved> {
        let info_hash = params.info_hash.as_str();
        let torrent = self.ready_torrent(params).await?;
        if FAILED_STATUSES.contains(&torrent.status.as_str()) {
            tracing::info!(moch = KEY, %info_hash, status = %torrent.status, "Failed Deepbrid torrent download");
            self.forget(params, &torrent).await;
            return Ok(StaticResponse::FailedDownload.into());
        }
        if torrent.status != DOWNLOADED || torrent.links.is_empty() {
            tracing::info!(moch = KEY, %info_hash, file_index = %index_text(params.file_index), "Downloading to Deepbrid");
            self.context.cache.remove_moch_availability(KEY, info_hash);
            return Ok(StaticResponse::Downloading.into());
        }
        // Deepbrid packs multi-file torrents into a single RAR link, which Stremio cannot play.
        let mut targets = Vec::with_capacity(torrent.links.len());
        for link in &torrent.links {
            match self.client.link_target(link).await {
                Ok(target) => targets.push((link, file_name(&target))),
                Err(error) if error.status().is_some_and(|status| status >= 500) => {
                    tracing::info!(moch = KEY, %info_hash, "Deepbrid link is still being prepared");
                    return Ok(StaticResponse::Downloading.into());
                }
                Err(error) => return Err(error.into()),
            }
        }
        let Some((link, _)) = select_target(&targets, &params.cached_entry_info) else {
            tracing::info!(moch = KEY, %info_hash, file_index = %index_text(params.file_index), "Only Deepbrid archive is available");
            return Ok(StaticResponse::FailedRar.into());
        };
        self.context.cache.cache_moch_availability(KEY, info_hash, None);
        Ok(Resolved::Url((*link).clone()))
    }

    async fn ready_torrent(&self, params: &ResolveParams) -> MochResult<Torrent> {
        let mut torrent = match self.known_torrent(params).await? {
            Some(torrent) => torrent,
            None => self.add_torrent(params).await?,
        };
        let deadline = tokio::time::Instant::now() + READY_WAIT;
        while is_pending(&torrent) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(POLL_INTERVAL).await;
            torrent = self.client.torrent(&params.api_key, &torrent.id).await?;
        }
        Ok(torrent)
    }

    async fn known_torrent(&self, params: &ResolveParams) -> MochResult<Option<Torrent>> {
        let key = torrent_key(params);
        let Some(id) = self.torrent_ids.get(&key).await else { return Ok(None) };
        match self.client.torrent(&params.api_key, &id).await.map_err(MochError::from) {
            Ok(torrent) if !torrent.id.is_empty() => Ok(Some(torrent)),
            Err(error) if common_error(&error).is_some() => Err(error),
            _ => {
                self.torrent_ids.invalidate(&key).await;
                Ok(None)
            }
        }
    }

    async fn add_torrent(&self, params: &ResolveParams) -> MochResult<Torrent> {
        let magnet = magnet_link(self.context.repository.as_ref(), &params.info_hash).await;
        let id = self.client.add_torrent(&params.api_key, &magnet).await?;
        self.torrent_ids.insert(torrent_key(params), id.clone()).await;
        Ok(self.client.torrent(&params.api_key, &id).await?)
    }

    async fn forget(&self, params: &ResolveParams, torrent: &Torrent) {
        self.torrent_ids.invalidate(&torrent_key(params)).await;
        self.context.cache.remove_moch_availability(KEY, &params.info_hash);
        if let Err(error) = self.client.delete_torrent(&params.api_key, &torrent.id).await {
            tracing::warn!(moch = KEY, info_hash = %params.info_hash, error = %error, "Failed deleting Deepbrid torrent");
        }
    }
}

fn torrent_key(params: &ResolveParams) -> String {
    format!("{}|{}", params.api_key, params.info_hash)
}

fn is_pending(torrent: &Torrent) -> bool {
    torrent.status != DOWNLOADED && !FAILED_STATUSES.contains(&torrent.status.as_str())
}

fn file_name(url: &str) -> String {
    let path = url::Url::parse(url).map_or_else(|_| url.to_owned(), |url| url.path().to_owned());
    let name = path.rsplit('/').next().unwrap_or_default().replace('+', " ");
    percent_encoding::percent_decode_str(&name).decode_utf8_lossy().into_owned()
}

/// The playable link whose file name matches the requested one, otherwise the first playable link.
fn select_target<'a>(targets: &'a [(&'a String, String)], expected: &str) -> Option<&'a (&'a String, String)> {
    let playable: Vec<&(&String, String)> =
        targets.iter().filter(|(_, name)| !is_archive(name) && (is_video(name) || targets.len() == 1)).collect();
    playable
        .iter()
        .find(|(_, name)| !expected.is_empty() && expected != "null" && same_filename(name, expected))
        .or_else(|| playable.first())
        .copied()
}

fn api_code(error: &MochError) -> Option<i64> {
    error.provider().and_then(debrid::deepbrid::error_code)
}

fn common_error(error: &MochError) -> Option<CommonError> {
    match error {
        MochError::Common(common) => Some(*common),
        _ => match api_code(error) {
            Some(401) => Some(CommonError::BadToken),
            Some(403 | NOT_PREMIUM) => Some(CommonError::AccessDenied),
            Some(503) => Some(CommonError::Unavailable),
            _ => None,
        },
    }
}

fn static_for_error(error: &MochError, params: &ResolveParams) -> MochResult<Resolved> {
    let code = api_code(error);
    let rules = [
        Rule::new(
            matches!(code, Some(401 | 403 | NOT_PREMIUM)),
            StaticResponse::FailedAccess,
            "Access denied to Deepbrid {}",
        ),
        Rule::new(code == Some(429), StaticResponse::LimitsExceeded, "Limits exceeded in Deepbrid {}"),
        Rule::new(code == Some(503), StaticResponse::FailedUnavailable, "Deepbrid is under maintenance {}"),
    ];
    static_or_err(&rules, &resolve_target(params), || {
        adding_error("Deepbrid", quoted(error_text(error, debrid::deepbrid::error_message)))
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn api_error(status: u16, code: i64) -> MochError {
        debrid::Error::api(Some(status), json!({ "error": code, "message": "nope" })).into()
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

    fn target(name: &str) -> (String, String) {
        (format!("https://www.deepbrid.com/mytorrents?file={name}"), name.to_owned())
    }

    fn selected(targets: &[(String, String)], expected: &str) -> Option<String> {
        let borrowed: Vec<(&String, String)> = targets.iter().map(|(link, name)| (link, name.clone())).collect();
        select_target(&borrowed, expected).map(|(_, name)| name.clone())
    }

    #[test]
    fn auth_errors_are_common_errors() {
        assert_eq!(common_error(&api_error(401, 401)), Some(CommonError::BadToken));
        assert_eq!(common_error(&api_error(403, 403)), Some(CommonError::AccessDenied));
        assert_eq!(common_error(&api_error(200, NOT_PREMIUM)), Some(CommonError::AccessDenied));
        assert_eq!(common_error(&api_error(503, 503)), Some(CommonError::Unavailable));
        assert_eq!(common_error(&api_error(500, 500)), None);
    }

    #[test]
    fn errors_resolve_to_static_videos() {
        let cases = [
            (api_error(401, 401), StaticResponse::FailedAccess),
            (api_error(200, NOT_PREMIUM), StaticResponse::FailedAccess),
            (api_error(429, 429), StaticResponse::LimitsExceeded),
            (api_error(503, 503), StaticResponse::FailedUnavailable),
        ];
        for (error, response) in cases {
            assert_eq!(static_for_error(&error, &params()).expect("static video"), Resolved::Message(response));
        }
    }

    #[test]
    fn unknown_error_is_rejected_with_json_message() {
        let error = static_for_error(&api_error(500, 500), &params()).expect_err("rejection");
        assert_eq!(error.to_string(), "Failed Deepbrid adding torrent \"nope\"");
    }

    #[test]
    fn archives_are_not_playable() {
        assert_eq!(selected(&[target("Show.S01.rar")], ""), None);
        assert_eq!(selected(&[target("Movie.mkv")], "null"), Some("Movie.mkv".to_owned()));
    }

    #[test]
    fn picks_the_requested_file_or_the_first_video() {
        let targets = [target("Show.S01E01.mkv"), target("Show.S01E02.mkv"), target("Show.nfo")];
        assert_eq!(selected(&targets, "Show.S01E02.mkv"), Some("Show.S01E02.mkv".to_owned()));
        assert_eq!(selected(&targets, "Other.mkv"), Some("Show.S01E01.mkv".to_owned()));
    }

    #[test]
    fn file_name_is_decoded_from_the_download_url() {
        assert_eq!(
            file_name("https://byron.myfast.link/rd/dl/torrent/c4d0/La+notte+%281968%29+1080p.mkv"),
            "La notte (1968) 1080p.mkv"
        );
    }

    #[test]
    fn pending_until_downloaded_or_failed() {
        let torrent = |status: &str| Torrent { status: status.to_owned(), ..Torrent::default() };
        assert!(is_pending(&torrent("queued")));
        assert!(is_pending(&torrent("compressing")));
        assert!(!is_pending(&torrent("downloaded")));
        assert!(!is_pending(&torrent("dead")));
    }
}
