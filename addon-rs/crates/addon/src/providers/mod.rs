mod alldebrid;
mod debridlink;
mod easydebrid;
pub(crate) mod helper;
mod highway;
mod offcloud;
pub(crate) mod options;
mod premiumize;
mod putio;
mod realdebrid;
pub(crate) mod static_videos;
pub(crate) mod support;
mod torbox;

use std::{collections::HashMap, sync::Arc, time::Duration};

use async_trait::async_trait;
use indexmap::IndexSet;
use parking_lot::Mutex;
use tokio::time::timeout;

use crate::{
    application::error::HandlerError,
    domain::config::Config,
    domain::models::{CatalogMeta, ItemMeta},
    domain::repository::TorrentRepository,
    domain::stream::{BehaviorHints, Stream},
    infrastructure::breaker::{Breaker, Fired},
    infrastructure::cache::Cache,
    infrastructure::flight::NamedQueue,
    infrastructure::metrics::Metrics,
};
use helper::{encode_uri_component, enrich_meta, stream_filename, title_filename};
use static_videos::StaticResponse;

const AVAILABILITY_TIMEOUT: Duration = Duration::from_secs(30);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const MIN_API_KEY_SYMBOLS: usize = 15;
const TOKEN_BLACKLIST_MAX: usize = 20_000;
const UNRESTRICT_CONCURRENCY: usize = 100;
const META_CONCURRENCY: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommonError {
    BadToken,
    AccessDenied,
    AccessBlocked,
    NotFound,
    Unavailable,
}

#[derive(Debug, thiserror::Error, Clone)]
pub enum MochError {
    #[error("{0:?}")]
    Common(CommonError),
    #[error("{0}")]
    Provider(Arc<debrid::Error>),
    #[error("{0}")]
    Message(String),
    #[error("Timed out")]
    TimedOut,
}

impl From<debrid::Error> for MochError {
    fn from(error: debrid::Error) -> Self {
        Self::Provider(Arc::new(error))
    }
}

impl From<CommonError> for MochError {
    fn from(error: CommonError) -> Self {
        Self::Common(error)
    }
}

impl MochError {
    pub fn message(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }

    pub fn provider(&self) -> Option<&debrid::Error> {
        match self {
            Self::Provider(error) => Some(error),
            _ => None,
        }
    }
}

pub type MochResult<T> = Result<T, MochError>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolved {
    Url(String),
    Message(StaticResponse),
}

impl From<StaticResponse> for Resolved {
    fn from(response: StaticResponse) -> Self {
        Self::Message(response)
    }
}

impl Resolved {
    fn outcome(&self) -> &'static str {
        match self {
            Self::Url(_) => "success",
            Self::Message(response) => response.outcome(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Endpoints {
    pub torbox: Option<String>,
    pub highway: Option<String>,
}

pub struct Context {
    pub endpoints: Endpoints,
    pub repository: Arc<dyn TorrentRepository>,
    pub cache: Arc<Cache>,
    pub metrics: Metrics,
    pub http: debrid::Http,
}

#[derive(Clone, Debug, Default)]
pub struct CachedEntry {
    pub url: String,
    pub cached: bool,
    pub behavior_hints: Option<BehaviorHints>,
}

pub type CachedStreams = HashMap<String, CachedEntry>;

#[derive(Clone, Debug)]
pub struct ResolveParams {
    pub moch_key: String,
    pub api_key: String,
    pub info_hash: String,
    pub file_index: Option<i64>,
    pub cached_entry_info: String,
    pub ip: Option<String>,
    pub host: String,
    pub is_browser: bool,
}

#[async_trait]
pub trait Moch: Send + Sync {
    async fn cached_streams(
        &self,
        streams: &[Stream],
        api_key: &str,
        ip: Option<&str>,
    ) -> MochResult<Option<CachedStreams>>;

    async fn catalog(&self, api_key: &str, catalog_id: &str, config: &Config) -> MochResult<Vec<CatalogMeta>>;

    async fn item_meta(&self, item_id: &str, api_key: &str, ip: Option<&str>) -> MochResult<ItemMeta>;

    async fn resolve(&self, params: &ResolveParams) -> MochResult<Resolved>;

    fn to_common_error(&self, error: &MochError) -> Option<CommonError>;
}

pub struct MochInfo {
    pub key: &'static str,
    pub name: &'static str,
    pub short_name: &'static str,
    pub catalogs: &'static [&'static str],
    pub no_downloads: bool,
}

pub const MOCHS: &[MochInfo] = &[
    MochInfo { key: "realdebrid", name: "RealDebrid", short_name: "RD", catalogs: &[""], no_downloads: false },
    MochInfo { key: "premiumize", name: "Premiumize", short_name: "PM", catalogs: &[""], no_downloads: false },
    MochInfo { key: "alldebrid", name: "AllDebrid", short_name: "AD", catalogs: &[""], no_downloads: false },
    MochInfo { key: "debridlink", name: "DebridLink", short_name: "DL", catalogs: &[""], no_downloads: false },
    MochInfo { key: "easydebrid", name: "EasyDebrid", short_name: "ED", catalogs: &[], no_downloads: true },
    MochInfo { key: "offcloud", name: "Offcloud", short_name: "OC", catalogs: &[""], no_downloads: false },
    MochInfo {
        key: "torbox",
        name: "TorBox",
        short_name: "TB",
        catalogs: &["Torrents", "Usenet", "WebDL"],
        no_downloads: false,
    },
    MochInfo { key: "putio", name: "Put.io", short_name: "Putio", catalogs: &[""], no_downloads: false },
    MochInfo { key: "highway", name: "HighWay", short_name: "HW", catalogs: &[], no_downloads: false },
];

pub fn moch_info(key: &str) -> Option<&'static MochInfo> {
    MOCHS.iter().find(|info| info.key == key)
}

pub fn has_moch_configured(config: &Config) -> bool {
    MOCHS.iter().any(|info| config.credentials().is_set(info.key))
}

struct Entry {
    info: &'static MochInfo,
    instance: Box<dyn Moch>,
    resolve_breaker: Breaker,
    availability_breaker: Breaker,
    unrestrict_queue: NamedQueue<Resolved>,
}

pub struct Mochs {
    entries: Vec<Entry>,
    context: Arc<Context>,
    blacklist: Mutex<IndexSet<String>>,
    meta_queue: NamedQueue<Result<ItemMeta, MochError>>,
}

pub type Provider = (&'static MochInfo, Box<dyn Moch>);

pub fn default_providers(context: &Arc<Context>) -> Vec<Provider> {
    MOCHS
        .iter()
        .map(|info| {
            let context = Arc::clone(context);
            let instance = match info.key {
                "realdebrid" => realdebrid::build(context),
                "premiumize" => premiumize::build(context),
                "alldebrid" => alldebrid::build(context),
                "debridlink" => debridlink::build(context),
                "easydebrid" => easydebrid::build(context),
                "offcloud" => offcloud::build(context),
                "torbox" => torbox::build(context),
                "putio" => putio::build(context),
                _ => highway::build(context),
            };
            (info, instance)
        })
        .collect()
}

impl Mochs {
    pub fn new(context: Arc<Context>, providers: Vec<Provider>) -> Self {
        let entries = providers
            .into_iter()
            .map(|(info, instance)| Entry {
                info,
                instance,
                resolve_breaker: Breaker::new(info.key, context.metrics.clone()),
                availability_breaker: Breaker::new(format!("{}_availability", info.key), context.metrics.clone()),
                unrestrict_queue: NamedQueue::new(UNRESTRICT_CONCURRENCY),
            })
            .collect();
        Self { entries, context, blacklist: Mutex::default(), meta_queue: NamedQueue::new(META_CONCURRENCY) }
    }

    fn entry(&self, key: &str) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.info.key == key)
    }

    pub fn blacklist_size(&self) -> usize {
        self.blacklist.lock().len()
    }

    pub async fn apply(&self, streams: Vec<Stream>, config: &Config) -> Vec<Stream> {
        if streams.is_empty() || !has_moch_configured(config) {
            return streams;
        }
        let configured: Vec<&Entry> = config.credentials().configured().filter_map(|key| self.entry(key)).collect();
        let results =
            futures::future::join_all(configured.into_iter().map(|entry| self.availability(entry, &streams, config)))
                .await;
        process_results(streams, config, &results)
    }

    async fn availability(&self, entry: &Entry, streams: &[Stream], config: &Config) -> MochOutcome {
        let key = entry.info.key;
        let api_key = config.credentials().get(key).unwrap_or_default();
        if self.is_invalid_token(api_key, key) {
            return MochOutcome::failed(entry.info, CommonError::BadToken.into());
        }
        if entry.resolve_breaker.is_open() {
            return MochOutcome::failed(entry.info, CommonError::Unavailable.into());
        }
        let timer = self.context.metrics.availability_timer(key);
        let action = async {
            match timeout(AVAILABILITY_TIMEOUT, entry.instance.cached_streams(streams, api_key, config.ip())).await {
                Err(_) => Err(MochError::TimedOut),
                Ok(Ok(Some(found))) => Ok(found),
                Ok(Ok(None)) => Err(MochError::message(format!("No {key} availability results"))),
                Ok(Err(error)) => Err(error),
            }
        };
        let fired = entry
            .availability_breaker
            .fire(action, |error: &MochError| entry.instance.to_common_error(error).is_none())
            .await;
        match fired {
            Ok(found) => {
                timer.finish("ok");
                MochOutcome { info: entry.info, streams: Some(found), error: None }
            }
            Err(Fired::Open) => MochOutcome::failed(entry.info, CommonError::Unavailable.into()),
            Err(Fired::Failed(error)) => {
                timer.finish(if matches!(error, MochError::TimedOut) { "timeout" } else { "error" });
                let common = entry.instance.to_common_error(&error);
                if common == Some(CommonError::BadToken) {
                    self.blacklist_token(api_key, key);
                }
                MochOutcome { info: entry.info, streams: None, error: Some(common.map_or(error, MochError::Common)) }
            }
        }
    }

    pub async fn resolve(&self, params: ResolveParams) -> Option<Resolved> {
        let entry = self.entry(&params.moch_key)?;
        let metrics = &self.context.metrics;
        if self.is_invalid_token(&params.api_key, entry.info.key) {
            metrics.resolve_timer(entry.info.key).finish(StaticResponse::FailedAccess.outcome());
            return Some(StaticResponse::FailedAccess.into());
        }
        let id = format!(
            "{}_{}_{}_{}_{}",
            params.ip.as_deref().unwrap_or("undefined"),
            params.moch_key,
            params.api_key,
            params.info_hash,
            params.file_index.map_or_else(|| "undefined".to_owned(), |index| index.to_string()),
        );
        let resolved = entry
            .unrestrict_queue
            .wrap(id.clone(), || async {
                match self.context.cache.wrap_resolved_url(&id, self.resolve_with_breaker(entry, &params)).await {
                    Ok(resolved) => resolved,
                    Err(error) => {
                        tracing::warn!(moch = %params.moch_key, info_hash = %params.info_hash, "{error}");
                        StaticResponse::FailedUnexpected.into()
                    }
                }
            })
            .await;
        Some(resolved)
    }

    async fn resolve_with_breaker(&self, entry: &Entry, params: &ResolveParams) -> Result<Resolved, MochError> {
        let timer = self.context.metrics.resolve_timer(entry.info.key);
        let action = async {
            match timeout(RESOLVE_TIMEOUT, entry.instance.resolve(params)).await {
                Ok(result) => result,
                Err(_) => Err(MochError::TimedOut),
            }
        };
        let fired = entry
            .resolve_breaker
            .fire(action, |error: &MochError| entry.instance.to_common_error(error).is_none())
            .await;
        match fired {
            Ok(resolved) => {
                timer.finish(resolved.outcome());
                Ok(resolved)
            }
            Err(Fired::Open) => {
                let resolved = Resolved::from(StaticResponse::FailedUnavailable);
                timer.finish(resolved.outcome());
                Ok(resolved)
            }
            Err(Fired::Failed(error)) => {
                timer.finish("failed");
                Err(error)
            }
        }
    }

    pub async fn catalog(
        &self,
        moch_key: &str,
        catalog_id: &str,
        config: &Config,
    ) -> Result<Vec<CatalogMeta>, HandlerError> {
        let entry = self.entry(moch_key).ok_or(HandlerError::NotFound)?;
        let api_key = config.credentials().get(moch_key).unwrap_or_default();
        if self.is_invalid_token(api_key, moch_key) {
            return Err(HandlerError::NotFound);
        }
        if !entry.resolve_breaker.is_closed() {
            return Ok(Vec::new());
        }
        match entry.instance.catalog(api_key, catalog_id, config).await {
            Ok(metas) => Ok(metas),
            Err(error) => match entry.instance.to_common_error(&error) {
                Some(CommonError::BadToken) => {
                    self.blacklist_token(api_key, moch_key);
                    Err(HandlerError::NotFound)
                }
                Some(_) => Ok(Vec::new()),
                None => Err(HandlerError::message(error)),
            },
        }
    }

    pub async fn item_meta(&self, moch_key: &str, item_id: &str, config: &Config) -> Result<ItemMeta, HandlerError> {
        let entry = self.entry(moch_key).ok_or(HandlerError::NotFound)?;
        let api_key = config.credentials().get(moch_key).unwrap_or_default().to_owned();
        if self.is_invalid_token(&api_key, moch_key) {
            return Err(HandlerError::NotFound);
        }
        if !entry.resolve_breaker.is_closed() {
            return Ok(unavailable_meta(moch_key, item_id));
        }
        let meta_key = format!("{moch_key}:{item_id}:{api_key}");
        let meta = self
            .meta_queue
            .wrap(meta_key, || async {
                let meta = entry.instance.item_meta(item_id, &api_key, config.ip()).await?;
                Ok(enrich_meta(self.context.repository.as_ref(), meta).await)
            })
            .await
            .map_err(|error| match entry.instance.to_common_error(&error) {
                Some(CommonError::BadToken) => {
                    self.blacklist_token(&api_key, moch_key);
                    HandlerError::NotFound
                }
                Some(CommonError::NotFound) => HandlerError::NotFound,
                _ => HandlerError::message(error),
            })?;
        Ok(rewrite_meta_urls(meta, moch_key, item_id, config.host()))
    }

    fn is_invalid_token(&self, token: &str, moch_key: &str) -> bool {
        token.is_empty()
            || token.chars().count() < MIN_API_KEY_SYMBOLS
            || token.bytes().any(|byte| !(0x20..=0x7e).contains(&byte))
            || self.blacklist.lock().contains(&format!("{moch_key}|{token}"))
    }

    fn blacklist_token(&self, token: &str, moch_key: &str) {
        let token_key = format!("{moch_key}|{token}");
        tracing::info!(moch = %moch_key, "Blacklisting invalid token");
        let size = {
            let mut blacklist = self.blacklist.lock();
            if blacklist.len() >= TOKEN_BLACKLIST_MAX {
                blacklist.shift_remove_index(0);
            }
            blacklist.insert(token_key);
            blacklist.len()
        };
        self.context.metrics.token_blacklisted(moch_key, size);
    }
}

struct MochOutcome {
    info: &'static MochInfo,
    streams: Option<CachedStreams>,
    error: Option<MochError>,
}

impl MochOutcome {
    fn failed(info: &'static MochInfo, error: MochError) -> Self {
        Self { info, streams: None, error: Some(error) }
    }
}

fn rewrite_meta_urls(mut meta: ItemMeta, moch_key: &str, item_id: &str, host: &str) -> ItemMeta {
    for video in &mut meta.videos {
        let filename = encode_video_filename(&video.title);
        for stream in &mut video.streams {
            if !stream.url.starts_with("http") {
                stream.url = format!("{host}/resolve/{moch_key}/{}/{filename}", stream.url);
            }
            stream.behavior_hints =
                Some(BehaviorHints { binge_group: Some(item_id.to_owned()), ..BehaviorHints::default() });
        }
    }
    meta
}

fn encode_video_filename(title: &str) -> String {
    encode_uri_component(&title_filename(title))
}

fn unavailable_meta(moch_key: &str, item_id: &str) -> ItemMeta {
    ItemMeta {
        id: format!("{moch_key}:{item_id}"),
        kind: "other".to_owned(),
        name: "Debrid provider is currently unavailable".to_owned(),
        no_cache: true,
        ..ItemMeta::default()
    }
}

fn process_results(mut streams: Vec<Stream>, config: &Config, results: &[MochOutcome]) -> Vec<Stream> {
    let host = config.host();
    for result in results {
        if let Some(cached) = &result.streams {
            streams = populate_cached_links(streams, result.info, cached, host);
        } else if let Some(error_stream) =
            result.error.as_ref().and_then(|error| error_stream(result.info, error, host))
        {
            streams.push(error_stream);
        }
    }
    if !options::exclude_download_links(config) {
        streams = populate_download_links(streams, results, host);
    }
    streams.retain(|stream| stream.url.as_deref().is_some_and(|url| !url.is_empty()));
    streams
}

fn populate_cached_links(streams: Vec<Stream>, info: &MochInfo, cached: &CachedStreams, host: &str) -> Vec<Stream> {
    streams
        .into_iter()
        .map(|stream| {
            let entry =
                stream.info_hash.as_ref().and_then(|info_hash| cached.get(&cache_key(info_hash, stream.file_idx)));
            match entry.filter(|entry| entry.cached) {
                Some(entry) => Stream {
                    url: Some(format!("{host}/resolve/{}/{}/{}", info.key, entry.url, stream_filename(&stream))),
                    name: format!("[{}+] {}", info.short_name, stream.name),
                    title: stream.title,
                    behavior_hints: Some(
                        stream.behavior_hints.unwrap_or_default().merged(entry.behavior_hints.as_ref()),
                    ),
                    ..Stream::default()
                },
                None => stream,
            }
        })
        .collect()
}

fn populate_download_links(mut streams: Vec<Stream>, results: &[MochOutcome], host: &str) -> Vec<Stream> {
    let seeded_count = streams.iter().filter(|stream| !stream.title.contains("👤 0")).count();
    let additions: Vec<Stream> = streams
        .iter()
        .filter_map(|stream| stream.info_hash.as_ref().map(|info_hash| (stream, cache_key(info_hash, stream.file_idx))))
        .flat_map(|(stream, key)| {
            results.iter().filter_map(move |result| {
                let entry = result.streams.as_ref()?.get(&key)?;
                (!result.info.no_downloads && !entry.cached && is_healthy_stream(seeded_count, stream)).then(|| {
                    Stream {
                        name: format!("[{} download] {}", result.info.short_name, stream.name),
                        title: stream.title.clone(),
                        url: Some(format!(
                            "{host}/resolve/{}/{}/{}",
                            result.info.key,
                            entry.url,
                            stream_filename(stream)
                        )),
                        behavior_hints: stream.behavior_hints.clone(),
                        ..Stream::default()
                    }
                })
            })
        })
        .collect();
    streams.extend(additions);
    streams
}

fn is_healthy_stream(seeded_count: usize, stream: &Stream) -> bool {
    let zero_seeders = stream.title.contains("👤 0");
    let is_4k = stream.name.contains("4k");
    !zero_seeders || is_4k || seeded_count <= 5
}

pub fn cache_key(info_hash: &str, file_idx: Option<i32>) -> String {
    format!("{info_hash}@{}", file_idx.map_or_else(|| "undefined".to_owned(), |index| index.to_string()))
}

fn error_stream(info: &MochInfo, error: &MochError, host: &str) -> Option<Stream> {
    let MochError::Common(common) = error else {
        return None;
    };
    let (title, response) = match common {
        CommonError::BadToken => (format!("Invalid {} ApiKey/Token!", info.name), StaticResponse::FailedAccess),
        CommonError::AccessDenied => {
            (format!("Expired/invalid {} subscription!", info.name), StaticResponse::FailedAccess)
        }
        CommonError::AccessBlocked => {
            (format!("Access to {} is blocked!\nCheck your account or email.", info.name), StaticResponse::FailedAccess)
        }
        CommonError::Unavailable => (
            format!("{} is currently unavailable!\nPlease try again later.", info.name),
            StaticResponse::FailedUnavailable,
        ),
        CommonError::NotFound => return None,
    };
    Some(Stream {
        name: format!("Torrentio\n{} error", info.short_name),
        title,
        url: Some(format!("{host}/{}", response.path())),
        ..Stream::default()
    })
}
