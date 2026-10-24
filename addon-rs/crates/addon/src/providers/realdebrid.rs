use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat};
use debrid::realdebrid::{Client, Torrent, TorrentFile, error_code, error_description};
use futures::future::join_all;
use serde_json::Value;
use tokio::time::sleep;

use super::{
    CachedStreams, CommonError, Context, Moch, MochError, MochResult, ResolveParams, Resolved,
    static_videos::StaticResponse,
    support::{
        CachedName, Rule, adding_error, build_cached, index_text, info_hashes, is_truthy, quoted, resolve_target,
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

const MIN_SIZE: i64 = 5 * 1024 * 1024;
const CATALOG_PAGE_SIZE: u32 = 50;
const KEY: &str = "realdebrid";
const DEBRID_DOWNLOADS: &str = "Downloads";
const NOT_FOUND_RETRIES: u32 = 2;
const NOT_FOUND_RETRY_DELAY: Duration = Duration::from_millis(1000);
const OPEN_POLL_RATE: Duration = Duration::from_millis(2000);
const OPEN_MAX_POLLS: u32 = 15;
const FIND_LIST_LIMIT: u32 = 20;

struct RealDebrid {
    context: Arc<Context>,
    client: Client,
}

struct Session<'a> {
    context: &'a Arc<Context>,
    client: &'a Client,
    api_key: &'a str,
    ip: Option<&'a str>,
}

pub fn build(context: Arc<Context>) -> Box<dyn Moch> {
    let client = Client::new(context.http.clone());
    Box::new(RealDebrid { context, client })
}

#[async_trait]
impl Moch for RealDebrid {
    async fn cached_streams(
        &self,
        streams: &[Stream],
        api_key: &str,
        _ip: Option<&str>,
    ) -> MochResult<Option<CachedStreams>> {
        let available = self.context.cache.cached_availability(&info_hashes(streams)).await;
        let cached = build_cached(
            api_key,
            streams.iter().filter(|stream| {
                !stream
                    .info_hash
                    .as_ref()
                    .and_then(|info_hash| available.get(info_hash))
                    .is_some_and(|entry| entry.get("infringing").is_some_and(is_truthy))
            }),
            CachedName::Null,
            |_, stream, info_hash| {
                !cached_file_ids(stream.file_idx.map(i64::from), available.get(info_hash)).is_empty()
            },
        );
        Ok(Some(cached))
    }

    async fn catalog(&self, api_key: &str, _catalog_id: &str, config: &Config) -> MochResult<Vec<CatalogMeta>> {
        let page = config.skip() / 100 + 1;
        let session = self.session(api_key, config.ip());
        let mut metas = Vec::new();
        if page == 1 {
            metas.push(CatalogMeta {
                id: format!("{KEY}:{DEBRID_DOWNLOADS}"),
                kind: "other".to_owned(),
                name: DEBRID_DOWNLOADS.to_owned(),
            });
        }
        let torrents = session.client.list_torrents(api_key, page - 1, page, CATALOG_PAGE_SIZE).await?;
        metas.extend(torrents.into_iter().filter(|torrent| status_ready(&torrent.status)).map(|torrent| CatalogMeta {
            id: format!("{KEY}:{}", torrent.id),
            kind: "other".to_owned(),
            name: torrent.filename,
        }));
        Ok(metas)
    }

    async fn item_meta(&self, item_id: &str, api_key: &str, ip: Option<&str>) -> MochResult<ItemMeta> {
        let session = self.session(api_key, ip);
        if item_id == DEBRID_DOWNLOADS {
            let downloads = self.client.list_downloads(api_key, 0, 1, CATALOG_PAGE_SIZE).await?;
            let videos = downloads
                .into_iter()
                .map(|download| Video {
                    id: format!("{KEY}:{DEBRID_DOWNLOADS}:{}", download.id),
                    title: download.filename,
                    released: released(&download.generated, 0),
                    streams: vec![VideoStream { url: download.download, behavior_hints: None }],
                    ..Video::default()
                })
                .collect();
            return Ok(ItemMeta {
                id: format!("{KEY}:{DEBRID_DOWNLOADS}"),
                kind: "other".to_owned(),
                name: DEBRID_DOWNLOADS.to_owned(),
                videos,
                no_cache: true,
                ..ItemMeta::default()
            });
        }
        let torrent = session
            .torrent_info(item_id)
            .await
            .map_err(|error| if is_not_found(&error) { CommonError::NotFound.into() } else { error })?;
        let info_hash = torrent.hash.to_lowercase();
        let videos = torrent
            .files
            .iter()
            .filter(|file| file.selected)
            .filter(|file| is_video(&file.path))
            .enumerate()
            .map(|(index, file)| Video {
                id: format!("{KEY}:{}:{}", torrent.id, file.id),
                title: file.path.clone(),
                released: released(&torrent.added, index as i64),
                streams: vec![VideoStream {
                    url: format!("{api_key}/{info_hash}/null/{}", file.id - 1),
                    behavior_hints: None,
                }],
                ..Video::default()
            })
            .collect();
        Ok(ItemMeta {
            id: format!("{KEY}:{}", torrent.id),
            kind: "other".to_owned(),
            name: torrent.filename,
            info_hash: Some(info_hash),
            videos,
            ..ItemMeta::default()
        })
    }

    async fn resolve(&self, params: &ResolveParams) -> MochResult<Resolved> {
        let session = self.session(&params.api_key, params.ip.as_deref());
        let info_hash = params.info_hash.as_str();
        let file_index = params.file_index;
        let result = match session.resolve_torrent(info_hash, file_index).await {
            Err(error) if is_not_found(&error) => {
                tracing::info!(moch = "realdebrid", %info_hash, file_index = %index_text(file_index), "Stale RealDebrid torrent, recreating");
                session.retry_create_torrent(info_hash, file_index).await
            }
            other => other,
        };
        match result {
            Ok(url) => Ok(url),
            Err(error) => self.static_for_error(&error, params),
        }
    }

    fn to_common_error(&self, error: &MochError) -> Option<CommonError> {
        common_error(error)
    }
}

impl RealDebrid {
    fn session<'a>(&'a self, api_key: &'a str, ip: Option<&'a str>) -> Session<'a> {
        Session { context: &self.context, client: &self.client, api_key, ip }
    }

    fn static_for_error(&self, error: &MochError, params: &ResolveParams) -> MochResult<Resolved> {
        if is_infringing(error) {
            self.context.cache.cache_infringing(&params.info_hash);
        }
        let rules = [
            Rule::new(is_access_denied(error), StaticResponse::FailedAccess, "Access denied to RealDebrid {}"),
            Rule::new(
                is_infringing(error),
                StaticResponse::FailedInfringement,
                "Infringing file removed from RealDebrid {}",
            ),
            Rule::new(
                is_too_many_requests(error),
                StaticResponse::FailedUnavailable,
                "Too many requests to RealDebrid {}",
            ),
            Rule::new(is_limit_exceeded(error), StaticResponse::LimitsExceeded, "Limits exceeded in RealDebrid {}"),
            Rule::new(is_torrent_too_big(error), StaticResponse::FailedTooBig, "Torrent too big for RealDebrid {}"),
            Rule::new(is_failed_opening(error), StaticResponse::FailedOpening, "Failed RealDebrid opening torrent {}"),
        ];
        static_or_err(&rules, &resolve_target(params), || adding_error("RealDebrid", message_json(error)))
    }
}

impl Session<'_> {
    async fn resolve_torrent(&self, info_hash: &str, file_index: Option<i64>) -> MochResult<Resolved> {
        let torrent_id = self.create_or_find_torrent_id(info_hash, file_index).await?;
        let torrent = self.torrent_info(&torrent_id).await?;
        let status = torrent.status.as_str();
        if status_ready(status) {
            return self.unrestrict_link(&torrent, file_index, true).await;
        }
        if status_downloading(status) {
            tracing::info!(moch = "realdebrid", %info_hash, file_index = %index_text(file_index), "Downloading to RealDebrid");
            self.remove_availability(info_hash, &selected_ids(&torrent));
            return Ok(StaticResponse::Downloading.into());
        }
        if status_magnet_error(status) {
            tracing::warn!(
                moch = "realdebrid",
                %info_hash,
                file_index = %index_text(file_index),
                "Failed RealDebrid opening torrent due to magnet error"
            );
            return Ok(StaticResponse::FailedOpening.into());
        }
        if status_error(status) {
            return self.retry_create_torrent(info_hash, file_index).await;
        }
        if status_waiting_selection(status) || status_opening(status) {
            tracing::info!(moch = "realdebrid", %info_hash, file_index = %index_text(file_index), "Trying to select files on RealDebrid");
            let id = torrent.id.clone();
            return Ok(match self.select_torrent_files(Some(torrent), &id, None).await {
                Ok(()) => {
                    tracing::info!(moch = "realdebrid", %info_hash, file_index = %index_text(file_index), "Downloading to RealDebrid");
                    StaticResponse::Downloading
                }
                Err(error) => {
                    tracing::warn!(
                        moch = "realdebrid",
                        %info_hash,
                        file_index = %index_text(file_index),
                        %error,
                        "Failed RealDebrid opening torrent"
                    );
                    StaticResponse::FailedOpening
                }
            }
            .into());
        }
        Err(adding_error("RealDebrid", serde_json::to_string(&torrent).unwrap_or_default()))
    }

    async fn create_or_find_torrent_id(&self, info_hash: &str, file_index: Option<i64>) -> MochResult<String> {
        match self.find_torrent(info_hash, file_index).await? {
            Some(torrent_id) => Ok(torrent_id),
            None => self.create_torrent_id(info_hash, file_index, false).await,
        }
    }

    async fn find_torrent(&self, info_hash: &str, file_index: Option<i64>) -> MochResult<Option<String>> {
        let torrents = self.client.list_torrents(self.api_key, 0, 1, FIND_LIST_LIMIT).await?;
        let found: Vec<Torrent> = torrents
            .into_iter()
            .filter(|torrent| torrent.hash.to_lowercase() == info_hash)
            .filter(|torrent| !status_error(&torrent.status))
            .collect();
        Ok(self.find_best_fit_torrent(found, file_index).await.map(|torrent| torrent.id))
    }

    async fn find_best_fit_torrent(&self, mut torrents: Vec<Torrent>, file_index: Option<i64>) -> Option<Torrent> {
        if torrents.len() == 1 {
            return torrents.pop();
        }
        let infos = join_all(torrents.iter().map(|torrent| self.torrent_info(&torrent.id))).await;
        let mut best_fit: Vec<Torrent> =
            infos.into_iter().filter_map(Result::ok).filter(|torrent| has_selected_file(torrent, file_index)).collect();
        best_fit.sort_by_key(|torrent| std::cmp::Reverse(torrent.links.len()));
        best_fit.into_iter().next().or_else(|| torrents.into_iter().next())
    }

    async fn torrent_info(&self, torrent_id: &str) -> MochResult<Torrent> {
        self.retry_not_found(&format!("torrent info {torrent_id}"), || {
            self.client.torrent_info(self.api_key, torrent_id)
        })
        .await
    }

    async fn create_torrent_id(&self, info_hash: &str, file_index: Option<i64>, force: bool) -> MochResult<String> {
        let magnet = magnet_link(self.context.repository.as_ref(), info_hash).await;
        let added = self.client.add_magnet(self.api_key, &magnet, self.ip).await?;
        let Some(id) = added.id.clone().filter(|id| !id.is_empty()) else {
            return Err(MochError::message(format!(
                "No RealDebrid torrent id in addMagnet response: {}",
                serde_json::to_string(&added).unwrap_or_default()
            )));
        };
        let cached_ids = if force { String::new() } else { self.resolve_cached_file_ids(info_hash, file_index).await };
        if !cached_ids.is_empty() {
            self.retry_not_found(&format!("selectFiles cached ids {info_hash}"), || {
                self.client.select_files(self.api_key, &id, &cached_ids, self.ip)
            })
            .await?;
        } else if !force {
            self.select_torrent_files(None, &id, None).await?;
        }
        Ok(id)
    }

    async fn resolve_cached_file_ids(&self, info_hash: &str, file_index: Option<i64>) -> String {
        let available = self.context.cache.cached_availability(&[info_hash.to_owned()]).await;
        cached_file_ids(file_index, available.get(info_hash)).iter().map(i64::to_string).collect::<Vec<_>>().join(",")
    }

    async fn recreate_torrent_id(&self, info_hash: &str, file_index: Option<i64>, force: bool) -> MochResult<String> {
        let new_torrent_id = self.create_torrent_id(info_hash, file_index, force).await?;
        self.select_torrent_files(None, &new_torrent_id, file_index).await?;
        Ok(new_torrent_id)
    }

    async fn retry_create_torrent(&self, info_hash: &str, file_index: Option<i64>) -> MochResult<Resolved> {
        tracing::info!(moch = "realdebrid", %info_hash, file_index = %index_text(file_index), "Retry failed download in RealDebrid");
        let new_torrent_id = self.recreate_torrent_id(info_hash, file_index, true).await?;
        let new_torrent = self.torrent_info(&new_torrent_id).await?;
        if status_ready(&new_torrent.status) {
            self.unrestrict_link(&new_torrent, file_index, false).await
        } else {
            Ok(StaticResponse::FailedDownload.into())
        }
    }

    async fn select_torrent_files(
        &self,
        known: Option<Torrent>,
        torrent_id: &str,
        file_index: Option<i64>,
    ) -> MochResult<()> {
        let torrent = match known.filter(|torrent| status_waiting_selection(&torrent.status)) {
            Some(torrent) => torrent,
            None => self.open_torrent(torrent_id).await?,
        };
        if status_waiting_selection(&torrent.status) {
            let video_file_ids = match file_index {
                Some(index) => (index + 1).to_string(),
                None => video_file_ids(&torrent.files),
            };
            if video_file_ids.is_empty() {
                return Err(MochError::message("Failed RealDebrid torrent file selection"));
            }
            return self
                .retry_not_found(&format!("selectFiles {}", torrent.hash), || {
                    self.client.select_files(self.api_key, &torrent.id, &video_file_ids, self.ip)
                })
                .await;
        }
        if status_ready(&torrent.status) || status_downloading(&torrent.status) {
            return Ok(());
        }
        Err(MochError::message("Failed RealDebrid torrent file selection"))
    }

    async fn open_torrent(&self, torrent_id: &str) -> MochResult<Torrent> {
        let mut polls = 0;
        loop {
            let torrent = self.torrent_info(torrent_id).await?;
            if status_opening(&torrent.status) && polls < OPEN_MAX_POLLS {
                sleep(OPEN_POLL_RATE).await;
                polls += 1;
            } else {
                return Ok(torrent);
            }
        }
    }

    async fn retry_not_found<T, F, Fut>(&self, step: &str, mut method: F) -> MochResult<T>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = debrid::Result<T>>,
    {
        let mut attempt = 0;
        loop {
            match method().await {
                Ok(result) => {
                    if attempt > 0 {
                        tracing::info!(moch = "realdebrid", %step, attempt, "RealDebrid found after retries");
                    }
                    return Ok(result);
                }
                Err(error) => {
                    let not_found = error_code(&error) == Some(NOT_FOUND);
                    if not_found && attempt < NOT_FOUND_RETRIES {
                        sleep(NOT_FOUND_RETRY_DELAY).await;
                        attempt += 1;
                    } else {
                        if not_found {
                            tracing::info!(moch = "realdebrid", %step, "RealDebrid not found");
                        }
                        return Err(error.into());
                    }
                }
            }
        }
    }

    async fn unrestrict_link(
        &self,
        torrent: &Torrent,
        file_index: Option<i64>,
        should_retry: bool,
    ) -> MochResult<Resolved> {
        let Some(target) = target_file(&torrent.files, file_index) else {
            return Err(MochError::message(format!(
                "No RealDebrid file found to unrestrict for {} [{}]",
                torrent.hash,
                index_text(file_index)
            )));
        };
        if !target.selected {
            tracing::info!(
                moch = "realdebrid",
                file = %serde_json::to_string(target).unwrap_or_default(),
                "Target RealDebrid file is not downloaded"
            );
            self.recreate_torrent_id(&torrent.hash.to_lowercase(), file_index, false).await?;
            return Ok(StaticResponse::Downloading.into());
        }
        let file_link = file_link(torrent, target);
        if should_retry && file_link.is_none_or(str::is_empty) {
            tracing::info!(
                moch = "realdebrid",
                info_hash = %torrent.hash,
                file_index = %index_text(file_index),
                "No RealDebrid links found"
            );
            return Box::pin(self.retry_create_torrent(&torrent.hash, file_index)).await;
        }
        self.unrestrict_file_link(file_link, torrent, file_index, should_retry).await
    }

    async fn unrestrict_file_link(
        &self,
        file_link: Option<&str>,
        torrent: &Torrent,
        file_index: Option<i64>,
        should_retry: bool,
    ) -> MochResult<Resolved> {
        let error = match self.unrestrict_and_cache(file_link, torrent, file_index, should_retry).await {
            Ok(url) => return Ok(url),
            Err(error) => error,
        };
        if is_not_found(&error) {
            tracing::info!(moch = "realdebrid", info_hash = %torrent.hash, "RealDebrid not found on unrestrict link");
        }
        if should_retry && error_code_of(&error) == Some(HOSTER_UNAVAILABLE) {
            tracing::info!(
                moch = "realdebrid",
                info_hash = %torrent.hash,
                file_index = %index_text(file_index),
                "Retry download as hoster is unavailable"
            );
            return Box::pin(self.retry_create_torrent(&torrent.hash.to_lowercase(), file_index)).await;
        }
        Err(error)
    }

    async fn unrestrict_and_cache(
        &self,
        file_link: Option<&str>,
        torrent: &Torrent,
        file_index: Option<i64>,
        should_retry: bool,
    ) -> MochResult<Resolved> {
        let response = self.client.unrestrict_link(self.api_key, file_link, self.ip).await?;
        let resolved = if is_archive(&response.download) {
            if should_retry && file_index.is_some() && selected_ids(torrent).len() > 1 {
                tracing::info!(
                    moch = "realdebrid",
                    info_hash = %torrent.hash,
                    file_index = %index_text(file_index),
                    "Only archive is available, try to download single file"
                );
                Box::pin(self.retry_create_torrent(&torrent.hash, file_index)).await?
            } else {
                StaticResponse::FailedRar.into()
            }
        } else {
            Resolved::Url(response.download)
        };
        self.context.cache.cache_availability(&torrent.hash.to_lowercase(), &selected_ids(torrent));
        if matches!(&resolved, Resolved::Url(url) if url.is_empty()) {
            return Err(MochError::message(format!(
                "No download link returned for {} [{}]",
                torrent.hash,
                index_text(file_index)
            )));
        }
        Ok(resolved)
    }

    fn remove_availability(&self, info_hash: &str, ids: &[i64]) {
        self.context.cache.remove_availability(info_hash, Some(ids));
    }
}

const NOT_FOUND: i64 = 7;
const HOSTER_UNAVAILABLE: i64 = 19;
const BAD_TOKEN: &[i64] = &[8];
const ACCESS_DENIED: &[i64] = &[8, 9, 20];
const INFRINGING: &[i64] = &[35];
const LIMIT_EXCEEDED: &[i64] = &[21, 23, 26, 36];
const TOO_MANY_REQUESTS: &[i64] = &[34];
const TORRENT_TOO_BIG: &[i64] = &[29];

fn released(timestamp: &str, offset_millis: i64) -> Option<String> {
    DateTime::parse_from_rfc3339(timestamp).ok().map(|time| {
        (time - chrono::Duration::milliseconds(offset_millis)).to_utc().to_rfc3339_opts(SecondsFormat::Millis, true)
    })
}

fn cached_file_ids(file_index: Option<i64>, entry: Option<&Value>) -> Vec<i64> {
    let Some(Value::Array(results)) = entry else {
        return Vec::new();
    };
    let ids = match file_index {
        Some(index) => {
            results.iter().filter_map(Value::as_array).find(|ids| ids.iter().any(|id| id.as_i64() == Some(index + 1)))
        }
        None => results.first().and_then(Value::as_array),
    };
    ids.map(|ids| ids.iter().filter_map(Value::as_i64).collect()).unwrap_or_default()
}

fn selected_ids(torrent: &Torrent) -> Vec<i64> {
    torrent.files.iter().filter(|file| file.selected).map(|file| file.id).collect()
}

fn video_file_ids(files: &[TorrentFile]) -> String {
    files
        .iter()
        .filter(|file| is_video(&file.path))
        .filter(|file| file.bytes > MIN_SIZE)
        .map(|file| file.id.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn has_selected_file(torrent: &Torrent, file_index: Option<i64>) -> bool {
    file_index.is_some_and(|index| torrent.files.iter().any(|file| file.id == index + 1 && file.selected))
}

fn target_file(files: &[TorrentFile], file_index: Option<i64>) -> Option<&TorrentFile> {
    file_index.and_then(|index| files.iter().find(|file| file.id == index + 1)).or_else(|| {
        let mut selected: Vec<&TorrentFile> = files.iter().filter(|file| file.selected).collect();
        selected.sort_by_key(|file| std::cmp::Reverse(file.bytes));
        selected.into_iter().next()
    })
}

fn file_link<'a>(torrent: &'a Torrent, target: &TorrentFile) -> Option<&'a str> {
    if torrent.links.len() == 1 {
        return torrent.links.first().map(String::as_str);
    }
    let position = torrent.files.iter().filter(|file| file.selected).position(|file| file.id == target.id)?;
    torrent.links.get(position).map(String::as_str)
}

fn status_error(status: &str) -> bool {
    matches!(status, "error" | "magnet_error")
}

fn status_magnet_error(status: &str) -> bool {
    status == "magnet_error"
}

fn status_opening(status: &str) -> bool {
    status == "magnet_conversion"
}

fn status_waiting_selection(status: &str) -> bool {
    status == "waiting_files_selection"
}

fn status_downloading(status: &str) -> bool {
    matches!(status, "downloading" | "uploading" | "queued")
}

fn status_ready(status: &str) -> bool {
    matches!(status, "downloaded" | "dead")
}

fn error_code_of(error: &MochError) -> Option<i64> {
    error.provider().and_then(error_code)
}

fn has_code(error: &MochError, codes: &[i64]) -> bool {
    error_code_of(error).is_some_and(|code| codes.contains(&code))
}

fn is_not_found(error: &MochError) -> bool {
    error_code_of(error) == Some(NOT_FOUND)
}

fn is_access_denied(error: &MochError) -> bool {
    has_code(error, ACCESS_DENIED)
}

fn is_infringing(error: &MochError) -> bool {
    has_code(error, INFRINGING)
}

fn is_limit_exceeded(error: &MochError) -> bool {
    has_code(error, LIMIT_EXCEEDED)
}

fn is_too_many_requests(error: &MochError) -> bool {
    has_code(error, TOO_MANY_REQUESTS)
}

fn is_torrent_too_big(error: &MochError) -> bool {
    has_code(error, TORRENT_TOO_BIG)
}

fn is_failed_opening(error: &MochError) -> bool {
    error.to_string().contains("file selection")
}

fn common_error(error: &MochError) -> Option<CommonError> {
    match error {
        MochError::Common(common) => Some(*common),
        _ if has_code(error, BAD_TOKEN) => Some(CommonError::BadToken),
        _ if is_access_denied(error) => Some(CommonError::AccessDenied),
        _ => None,
    }
}

fn message_json(error: &MochError) -> String {
    let Some(provider) = error.provider() else {
        return quoted(error.to_string());
    };
    if let Some(description) = error_code(provider).and_then(error_description) {
        return quoted(description);
    }
    match provider.body() {
        Some(body) => body.to_string(),
        None => quoted(provider.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn api_error(code: i64) -> MochError {
        debrid::Error::api(Some(403), json!({ "error": "x", "error_code": code })).into()
    }

    fn file(id: i64, path: &str, bytes: i64, selected: bool) -> TorrentFile {
        TorrentFile { id, path: path.to_owned(), bytes, selected }
    }

    fn torrent(files: Vec<TorrentFile>, links: &[&str]) -> Torrent {
        Torrent {
            id: "T1".to_owned(),
            hash: "ABC".to_owned(),
            files,
            links: links.iter().map(|link| (*link).to_owned()).collect(),
            ..Torrent::default()
        }
    }

    #[test]
    fn dead_and_downloaded_are_ready() {
        assert!(status_ready("downloaded"));
        assert!(status_ready("dead"));
        assert!(!status_ready("downloading"));
    }

    #[test]
    fn magnet_error_is_also_an_error() {
        assert!(status_error("magnet_error"));
        assert!(status_error("error"));
        assert!(!status_error("queued"));
    }

    #[test]
    fn queued_uploading_and_downloading_are_downloading() {
        assert!(status_downloading("queued"));
        assert!(status_downloading("uploading"));
        assert!(status_downloading("downloading"));
        assert!(!status_downloading("downloaded"));
    }

    #[test]
    fn cached_ids_for_index_pick_the_variant_containing_the_file() {
        let entry = json!([[1, 2, 3], [4, 5]]);
        assert_eq!(cached_file_ids(Some(3), Some(&entry)), vec![4, 5]);
    }

    #[test]
    fn cached_ids_without_index_take_the_first_variant() {
        let entry = json!([[1, 2, 3], [4, 5]]);
        assert_eq!(cached_file_ids(None, Some(&entry)), vec![1, 2, 3]);
    }

    #[test]
    fn cached_ids_ignore_non_array_entries() {
        let entry = json!({ "infringing": true });
        assert_eq!(cached_file_ids(None, Some(&entry)), Vec::<i64>::new());
        assert_eq!(cached_file_ids(Some(0), None), Vec::<i64>::new());
    }

    #[test]
    fn cached_ids_are_empty_when_no_variant_has_the_file() {
        let entry = json!([[1, 2]]);
        assert_eq!(cached_file_ids(Some(7), Some(&entry)), Vec::<i64>::new());
    }

    #[test]
    fn video_selection_skips_small_and_non_video_files() {
        let files = vec![
            file(1, "/a.mkv", MIN_SIZE + 1, false),
            file(2, "/b.mkv", MIN_SIZE, false),
            file(3, "/c.nfo", MIN_SIZE * 2, false),
            file(4, "/d.mp4", MIN_SIZE * 3, false),
        ];
        assert_eq!(video_file_ids(&files), "1,4");
    }

    #[test]
    fn target_file_prefers_the_requested_index() {
        let files = vec![file(1, "/a.mkv", 10, true), file(2, "/b.mkv", 99, true)];
        assert_eq!(target_file(&files, Some(0)).map(|file| file.id), Some(1));
    }

    #[test]
    fn target_file_falls_back_to_the_largest_selected() {
        let files = vec![file(1, "/a.mkv", 10, true), file(2, "/b.mkv", 99, true), file(3, "/c.mkv", 500, false)];
        assert_eq!(target_file(&files, None).map(|file| file.id), Some(2));
        assert_eq!(target_file(&files, Some(9)).map(|file| file.id), Some(2));
    }

    #[test]
    fn single_link_is_used_for_any_target() {
        let torrent = torrent(vec![file(1, "/a.mkv", 1, true), file(2, "/b.mkv", 1, true)], &["only"]);
        assert_eq!(file_link(&torrent, &torrent.files[1]), Some("only"));
    }

    #[test]
    fn link_follows_the_position_among_selected_files() {
        let torrent = torrent(
            vec![file(1, "/a.mkv", 1, false), file(2, "/b.mkv", 1, true), file(3, "/c.mkv", 1, true)],
            &["l2", "l3"],
        );
        assert_eq!(file_link(&torrent, &torrent.files[2]), Some("l3"));
    }

    #[test]
    fn best_fit_requires_the_file_to_be_selected() {
        let selected = torrent(vec![file(2, "/b.mkv", 1, true)], &[]);
        let unselected = torrent(vec![file(2, "/b.mkv", 1, false)], &[]);
        assert!(has_selected_file(&selected, Some(1)));
        assert!(!has_selected_file(&unselected, Some(1)));
        assert!(!has_selected_file(&selected, None));
    }

    #[test]
    fn bad_token_maps_to_common_bad_token() {
        assert_eq!(common_error(&api_error(8)), Some(CommonError::BadToken));
    }

    #[test]
    fn permission_and_hoster_plan_errors_map_to_access_denied() {
        assert_eq!(common_error(&api_error(9)), Some(CommonError::AccessDenied));
        assert_eq!(common_error(&api_error(20)), Some(CommonError::AccessDenied));
    }

    #[test]
    fn other_codes_are_not_common_errors() {
        assert_eq!(common_error(&api_error(34)), None);
        assert_eq!(common_error(&MochError::message("boom")), None);
    }

    #[test]
    fn classifies_limit_codes() {
        for code in [21, 23, 26, 36] {
            assert!(is_limit_exceeded(&api_error(code)));
        }
        assert!(!is_limit_exceeded(&api_error(34)));
    }

    #[test]
    fn classifies_single_code_errors() {
        assert!(is_infringing(&api_error(35)));
        assert!(is_too_many_requests(&api_error(34)));
        assert!(is_torrent_too_big(&api_error(29)));
        assert!(is_not_found(&api_error(7)));
    }

    #[test]
    fn failed_opening_matches_file_selection_messages() {
        assert!(is_failed_opening(&MochError::message("Failed RealDebrid torrent file selection")));
        assert!(!is_failed_opening(&MochError::message("Something else")));
    }

    #[test]
    fn known_error_codes_serialize_their_description() {
        assert_eq!(message_json(&api_error(34)), "\"Too many requests\"");
    }

    #[test]
    fn unknown_error_codes_serialize_the_body() {
        let error: MochError = debrid::Error::api(Some(500), json!({ "error": "boom", "error_code": 999 })).into();
        assert_eq!(message_json(&error), "{\"error\":\"boom\",\"error_code\":999}");
    }

    #[test]
    fn plain_messages_serialize_as_json_strings() {
        assert_eq!(message_json(&MochError::message("it \"broke\"")), "\"it \\\"broke\\\"\"");
    }

    #[test]
    fn released_subtracts_the_index_in_milliseconds() {
        assert_eq!(released("2020-01-01T00:00:01.000Z", 5).as_deref(), Some("2020-01-01T00:00:00.995Z"));
        assert_eq!(released("garbage", 0), None);
    }
}
