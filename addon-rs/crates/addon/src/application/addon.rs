use std::sync::{Arc, LazyLock};

use regex::Regex;
use serde::Serialize;

use crate::{
    application::error::HandlerError,
    domain::config::Config,
    domain::content_type::ContentType,
    domain::filter,
    domain::models::{CatalogMeta, ItemMeta, Record},
    domain::repository::TorrentRepository,
    domain::sort::sort_streams,
    domain::stream::{Stream, StreamsResponse},
    domain::stream_info::to_stream_info,
    infrastructure::cache::Cache,
    infrastructure::flight::{Limiter, NamedQueue},
    infrastructure::magnet::enrich_stream_sources,
    providers::{Mochs, static_videos::is_static_url},
};

const CACHE_MAX_AGE_EMPTY: u32 = 60;
const CATALOG_CACHE_MAX_AGE: u32 = 0;
const STALE_REVALIDATE_AGE: u32 = 4 * 60 * 60;
const STALE_ERROR_AGE: u32 = 7 * 24 * 60 * 60;
const REQUEST_QUEUE_CONCURRENCY: usize = 200;
const DB_CONCURRENCY: usize = 50;
const DEFAULT_CACHE_MAX_AGE: u32 = 60 * 60;

static IMDB_ANYWHERE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)tt[0-9]+").expect("valid regex"));
static KITSU_ANYWHERE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)kitsu:[0-9]+").expect("valid regex"));
static IMDB_SERIES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^tt[0-9]+:[0-9]+:[0-9]+$").expect("valid regex"));
static IMDB_MOVIE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^tt[0-9]+$").expect("valid regex"));
static KITSU: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^kitsu:[0-9]+(?::[0-9]+)?$").expect("valid regex"));

#[derive(Serialize)]
pub struct CatalogResponse {
    pub metas: Vec<CatalogMeta>,
    #[serde(rename = "cacheMaxAge")]
    pub cache_max_age: u32,
}

#[derive(Serialize)]
pub struct MetaResponse {
    pub meta: ItemMeta,
    #[serde(rename = "cacheMaxAge")]
    pub cache_max_age: u32,
}

pub struct Addon {
    repository: Arc<dyn TorrentRepository>,
    cache: Arc<Cache>,
    mochs: Mochs,
    request_queue: NamedQueue<Result<Arc<Vec<Stream>>, HandlerError>>,
    db_limiter: Limiter,
    cache_max_age: u32,
}

impl Addon {
    pub fn new(repository: Arc<dyn TorrentRepository>, cache: Arc<Cache>, mochs: Mochs) -> Self {
        let cache_max_age = std::env::var("CACHE_MAX_AGE")
            .ok()
            .and_then(|value| value.parse().ok())
            .filter(|age| *age != 0)
            .unwrap_or(DEFAULT_CACHE_MAX_AGE);
        Self {
            repository,
            cache,
            mochs,
            request_queue: NamedQueue::new(REQUEST_QUEUE_CONCURRENCY),
            db_limiter: Limiter::new(DB_CONCURRENCY),
            cache_max_age,
        }
    }

    pub fn mochs(&self) -> &Mochs {
        &self.mochs
    }

    pub fn cache(&self) -> &Cache {
        &self.cache
    }

    pub fn repository(&self) -> &dyn TorrentRepository {
        &*self.repository
    }

    pub async fn streams(
        &self,
        content_type: &str,
        id: &str,
        config: &Config,
    ) -> Result<StreamsResponse, HandlerError> {
        let Some(content_type @ (ContentType::Movie | ContentType::Series | ContentType::Anime)) =
            ContentType::parse(content_type)
        else {
            return Ok(StreamsResponse::default());
        };
        if !IMDB_ANYWHERE.is_match(id) && !KITSU_ANYWHERE.is_match(id) {
            return Ok(StreamsResponse::default());
        }
        let cached = self.request_queue.wrap(id, || self.resolve_streams(content_type, id)).await?;
        let streams = filter::apply(&cached, config, content_type);
        let mut streams = sort_streams(streams, config);
        enrich_stream_sources(&mut streams);
        let streams = self.mochs.apply(streams, config).await;
        Ok(self.with_cache_params(streams))
    }

    async fn resolve_streams(&self, content_type: ContentType, id: &str) -> Result<Arc<Vec<Stream>>, HandlerError> {
        self.cache
            .wrap_stream(id, || async {
                let records = self.db_limiter.run(self.records(content_type, id)).await?;
                tokio::task::spawn_blocking(move || to_streams(records)).await.map_err(HandlerError::failed)
            })
            .await
    }

    async fn records(&self, content_type: ContentType, id: &str) -> Result<Vec<Record>, HandlerError> {
        let result = if content_type == ContentType::Movie {
            self.movie_records(id).await
        } else {
            self.series_records(id).await
        };
        result.map_err(HandlerError::failed)
    }

    async fn series_records(&self, id: &str) -> Result<Vec<Record>, anyhow::Error> {
        if IMDB_SERIES.is_match(id) {
            let mut parts = id.split(':');
            let imdb_id = parts.next().unwrap_or_default();
            let season = parts.next().and_then(|part| part.parse().ok()).unwrap_or(1);
            let episode = parts.next().and_then(|part| part.parse().ok()).unwrap_or(1);
            return self.repository.imdb_series_entries(imdb_id, season, episode).await;
        }
        if KITSU.is_match(id) {
            let mut parts = id.split(':');
            let kitsu_id = parts.nth(1).and_then(|part| part.parse().ok()).unwrap_or_default();
            return match parts.next().and_then(|part| part.parse().ok()) {
                Some(episode) => self.repository.kitsu_series_entries(kitsu_id, episode).await,
                None => self.repository.kitsu_movie_entries(kitsu_id).await,
            };
        }
        Ok(Vec::new())
    }

    async fn movie_records(&self, id: &str) -> Result<Vec<Record>, anyhow::Error> {
        if IMDB_MOVIE.is_match(id) {
            return self.repository.imdb_movie_entries(id).await;
        }
        if KITSU.is_match(id) {
            return self.series_records(id).await;
        }
        Ok(Vec::new())
    }

    fn with_cache_params(&self, streams: Vec<Stream>) -> StreamsResponse {
        let cache_age = if streams.is_empty() {
            CACHE_MAX_AGE_EMPTY
        } else if streams.iter().all(|stream| stream.url.as_deref().is_some_and(is_static_url)) {
            0
        } else {
            self.cache_max_age
        };
        StreamsResponse {
            streams,
            cache_max_age: Some(cache_age),
            stale_revalidate: Some(STALE_REVALIDATE_AGE),
            stale_error: Some(STALE_ERROR_AGE),
        }
    }

    pub async fn catalog(&self, catalog_id: &str, config: &Config) -> Result<CatalogResponse, HandlerError> {
        let mut parts = catalog_id.split('-');
        let moch_key = parts.nth(1).unwrap_or_default();
        let id = parts.next().unwrap_or_default();
        let metas = self.mochs.catalog(moch_key, id, config).await?;
        Ok(CatalogResponse { metas, cache_max_age: CATALOG_CACHE_MAX_AGE })
    }

    pub async fn meta(&self, meta_id: &str, config: &Config) -> Result<MetaResponse, HandlerError> {
        let mut parts = meta_id.split(':');
        let moch_key = parts.next().unwrap_or_default();
        let item_id = parts.next().unwrap_or_default();
        let meta = self.mochs.item_meta(moch_key, item_id, config).await?;
        let cache_max_age = if meta.no_cache { 0 } else { self.cache_max_age };
        Ok(MetaResponse { meta, cache_max_age })
    }
}

fn to_streams(mut records: Vec<Record>) -> Vec<Stream> {
    records.sort_by(|a, b| {
        let seeders = |record: &Record| i64::from(record.torrent.seeders.unwrap_or(0));
        seeders(b).cmp(&seeders(a)).then_with(|| b.torrent.upload_date.cmp(&a.torrent.upload_date))
    });
    records.iter().map(to_stream_info).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use chrono::Utc;

    use super::*;
    use crate::{
        domain::models::{CatalogMeta, FileRow, ItemMeta, TorrentRow},
        infrastructure::{
            cache::{Cache, Stores},
            metrics::Metrics,
        },
        providers::{
            CachedEntry, CachedStreams, CommonError, Context, Endpoints, Moch, MochError, MochResult, Provider,
            ResolveParams, Resolved, cache_key, moch_info, static_videos::StaticResponse,
        },
    };

    #[derive(Default)]
    struct FakeRepository {
        records: Vec<Record>,
        fail: bool,
        lookups: AtomicUsize,
    }

    #[async_trait]
    impl TorrentRepository for FakeRepository {
        async fn torrent(&self, _info_hash: &str) -> anyhow::Result<Option<TorrentRow>> {
            Ok(None)
        }

        async fn files(&self, _info_hashes: &[String]) -> anyhow::Result<Vec<FileRow>> {
            Ok(Vec::new())
        }

        async fn imdb_movie_entries(&self, _imdb_id: &str) -> anyhow::Result<Vec<Record>> {
            self.lookups.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                anyhow::bail!("database is down");
            }
            Ok(self.records.clone())
        }

        async fn imdb_series_entries(&self, _: &str, _: i32, _: i32) -> anyhow::Result<Vec<Record>> {
            self.imdb_movie_entries("").await
        }

        async fn kitsu_movie_entries(&self, _kitsu_id: i32) -> anyhow::Result<Vec<Record>> {
            self.imdb_movie_entries("").await
        }

        async fn kitsu_series_entries(&self, _kitsu_id: i32, _episode: i32) -> anyhow::Result<Vec<Record>> {
            self.imdb_movie_entries("").await
        }
    }

    #[derive(Default)]
    struct FakeMoch {
        resolves: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl Moch for FakeMoch {
        async fn cached_streams(
            &self,
            streams: &[Stream],
            api_key: &str,
            _ip: Option<&str>,
        ) -> MochResult<Option<CachedStreams>> {
            Ok(Some(
                streams
                    .iter()
                    .filter_map(|stream| {
                        let hash = stream.info_hash.clone()?;
                        let entry = CachedEntry {
                            url: format!("{api_key}/{hash}/file/0"),
                            cached: hash.starts_with('a'),
                            behavior_hints: None,
                        };
                        Some((cache_key(&hash, stream.file_idx), entry))
                    })
                    .collect(),
            ))
        }

        async fn catalog(&self, _: &str, _: &str, _: &Config) -> MochResult<Vec<CatalogMeta>> {
            Ok(Vec::new())
        }

        async fn item_meta(&self, _: &str, _: &str, _: Option<&str>) -> MochResult<ItemMeta> {
            Err(CommonError::NotFound.into())
        }

        async fn resolve(&self, params: &ResolveParams) -> MochResult<Resolved> {
            self.resolves.fetch_add(1, Ordering::SeqCst);
            if params.info_hash == "bad" {
                return Err(MochError::message("boom"));
            }
            Ok(Resolved::Url(format!("https://cdn.example/{}", params.info_hash)))
        }

        fn to_common_error(&self, _error: &MochError) -> Option<CommonError> {
            None
        }
    }

    fn record(info_hash: &str, title: &str, seeders: i16) -> Record {
        Record {
            info_hash: info_hash.to_owned(),
            file_index: None,
            title: title.to_owned(),
            size: Some(1_610_612_736),
            kitsu_id: None,
            torrent: TorrentRow {
                info_hash: info_hash.to_owned(),
                provider: "YTS".to_owned(),
                torrent_id: None,
                title: title.to_owned(),
                size: Some(1_610_612_736),
                kind: "movie".to_owned(),
                upload_date: Utc::now(),
                seeders: Some(seeders),
                trackers: None,
                languages: None,
                resolution: None,
            },
        }
    }

    struct Harness {
        addon: Addon,
        repository: Arc<FakeRepository>,
        resolves: Arc<AtomicUsize>,
    }

    fn harness(repository: FakeRepository) -> Harness {
        let repository = Arc::new(repository);
        let metrics = Metrics::new();
        let cache = Arc::new(Cache::new(metrics.clone(), Stores { streams: None, availability: None }));
        let context = Arc::new(Context {
            endpoints: Endpoints::default(),
            repository: Arc::clone(&repository) as Arc<dyn TorrentRepository>,
            cache: Arc::clone(&cache),
            metrics,
            http: debrid::Http::new(std::time::Duration::from_secs(1)).unwrap(),
        });
        let resolves = Arc::new(AtomicUsize::new(0));
        let provider: Provider = (moch_info("torbox").unwrap(), Box::new(FakeMoch { resolves: Arc::clone(&resolves) }));
        let mochs = Mochs::new(Arc::clone(&context), vec![provider]);
        let addon = Addon::new(Arc::clone(&repository) as Arc<dyn TorrentRepository>, cache, mochs);
        Harness { addon, repository, resolves }
    }

    fn config(configuration: &str) -> Config {
        Config::parse(configuration).with_host("http://localhost:7000")
    }

    fn sample() -> FakeRepository {
        FakeRepository {
            records: vec![
                record("aaa", "Movie.2020.720p.WEB-DL.x264-GRP", 40),
                record("bbb", "Movie.2020.1080p.BluRay.x264-GRP", 10),
            ],
            ..FakeRepository::default()
        }
    }

    #[tokio::test]
    async fn builds_stream_listings_from_repository_records() {
        let harness = harness(sample());
        let response = harness.addon.streams("movie", "tt0000001", &config("")).await.unwrap();
        let names: Vec<&str> = response.streams.iter().map(|stream| stream.name.as_str()).collect();
        assert_eq!(names, ["Torrentio\n1080p", "Torrentio\n720p"]);
        assert_eq!(response.cache_max_age, Some(3600));
        assert!(response.streams.iter().all(|stream| stream.url.is_none()));
    }

    #[tokio::test]
    async fn answers_unsupported_requests_without_touching_the_repository() {
        let harness = harness(sample());
        assert_eq!(harness.addon.streams("tv", "tt1", &config("")).await.unwrap().streams, []);
        assert_eq!(harness.addon.streams("movie", "unknown", &config("")).await.unwrap().streams, []);
        assert_eq!(harness.repository.lookups.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn serves_repeat_requests_from_the_cache() {
        let harness = harness(sample());
        harness.addon.streams("movie", "tt0000001", &config("")).await.unwrap();
        harness.addon.streams("movie", "tt0000001", &config("sort=size")).await.unwrap();
        assert_eq!(harness.repository.lookups.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn surfaces_repository_failures_with_their_cause() {
        let harness = harness(FakeRepository { fail: true, ..FakeRepository::default() });
        let error = harness.addon.streams("movie", "tt0000001", &config("")).await.unwrap_err();
        assert!(error.to_string().contains("database is down"));
    }

    #[tokio::test]
    async fn replaces_cached_streams_with_debrid_links() {
        let harness = harness(sample());
        let response =
            harness.addon.streams("movie", "tt0000001", &config("torbox=abcdefghijklmnopqrstuvwxyz")).await.unwrap();
        let cached: Vec<&Stream> = response.streams.iter().filter(|stream| stream.name.starts_with("[TB+]")).collect();
        let downloads: Vec<&Stream> =
            response.streams.iter().filter(|stream| stream.name.starts_with("[TB download]")).collect();
        assert_eq!(cached.len(), 1);
        assert_eq!(downloads.len(), 1);
        assert!(
            cached[0]
                .url
                .as_deref()
                .unwrap()
                .starts_with("http://localhost:7000/resolve/torbox/abcdefghijklmnopqrstuvwxyz/aaa/")
        );
    }

    #[tokio::test]
    async fn debrid_download_links_can_be_disabled() {
        let harness = harness(sample());
        let response = harness
            .addon
            .streams("movie", "tt0000001", &config("torbox=abcdefghijklmnopqrstuvwxyz|debridoptions=nodownloadlinks"))
            .await
            .unwrap();
        assert!(response.streams.iter().all(|stream| !stream.name.starts_with("[TB download]")));
    }

    fn resolve_params(info_hash: &str, api_key: &str) -> ResolveParams {
        ResolveParams {
            moch_key: "torbox".to_owned(),
            api_key: api_key.to_owned(),
            info_hash: info_hash.to_owned(),
            file_index: Some(0),
            cached_entry_info: "file".to_owned(),
            ip: None,
            host: "http://localhost:7000".to_owned(),
            is_browser: false,
        }
    }

    #[tokio::test]
    async fn resolves_and_caches_playback_urls() {
        let harness = harness(sample());
        let key = "abcdefghijklmnopqrstuvwxyz";
        let first = harness.addon.mochs().resolve(resolve_params("aaa", key)).await;
        let second = harness.addon.mochs().resolve(resolve_params("aaa", key)).await;
        assert_eq!(first, Some(Resolved::Url("https://cdn.example/aaa".to_owned())));
        assert_eq!(second, first);
        assert_eq!(harness.resolves.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failed_resolves_are_not_cached() {
        let harness = harness(sample());
        let key = "abcdefghijklmnopqrstuvwxyz";
        let first = harness.addon.mochs().resolve(resolve_params("bad", key)).await.unwrap();
        assert_eq!(first, Resolved::Message(StaticResponse::FailedUnexpected));
        harness.addon.mochs().resolve(resolve_params("bad", key)).await.unwrap();
        assert_eq!(harness.resolves.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn invalid_tokens_resolve_to_the_access_video() {
        let harness = harness(sample());
        let resolved = harness.addon.mochs().resolve(resolve_params("aaa", "short")).await.unwrap();
        assert_eq!(resolved, Resolved::Message(StaticResponse::FailedAccess));
        assert_eq!(harness.resolves.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn unknown_providers_do_not_resolve() {
        let harness = harness(sample());
        let mut params = resolve_params("aaa", "abcdefghijklmnopqrstuvwxyz");
        params.moch_key = "nope".to_owned();
        assert!(harness.addon.mochs().resolve(params).await.is_none());
    }
}
