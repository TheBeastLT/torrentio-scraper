use std::{sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

use super::{
    error::{CatalogError, HandlerError},
    limiter::Limiter,
};
use crate::{
    domain::{
        CacheStore, Catalog, DEFAULT_GENRE, DEFAULT_PROVIDERS, IdQuery, IdRepository, MetadataSource, date_range,
        find_catalog, normalize_genre,
    },
    infrastructure::metrics::Metrics,
};

const DEFAULT_CACHE_MAX_AGE: u32 = 4 * 60 * 60;
const STALE_REVALIDATE_AGE: u32 = 4 * 60 * 60;
const STALE_ERROR_AGE: u32 = 7 * 24 * 60 * 60;
const EMPTY_CACHE_MAX_AGE: u32 = 30 * 60;
const CATALOG_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const DEFAULT_MAX_CONCURRENT: usize = 20;
const DEFAULT_QUEUE_SIZE: usize = 50;

#[derive(Debug, Clone, Copy)]
pub struct Settings {
    pub cache_max_age: u32,
    pub max_concurrent: usize,
    pub queue_size: usize,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            cache_max_age: DEFAULT_CACHE_MAX_AGE,
            max_concurrent: DEFAULT_MAX_CONCURRENT,
            queue_size: DEFAULT_QUEUE_SIZE,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Extra {
    pub genre: Option<String>,
    pub skip: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResponse {
    pub metas: Vec<Value>,
    pub cache_max_age: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_revalidate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_error: Option<u32>,
}

pub struct Catalogs {
    ids: Arc<dyn IdRepository>,
    metadata: Arc<dyn MetadataSource>,
    store: Option<Arc<dyn CacheStore>>,
    metrics: Metrics,
    limiter: Limiter,
    settings: Settings,
}

struct Page<'a> {
    catalog: &'static Catalog,
    providers: &'a [String],
    genre: &'a str,
    offset: Option<i64>,
    now: DateTime<Utc>,
}

impl Page<'_> {
    fn key(&self) -> String {
        let date = self.now.format("%Y-%m-%d");
        format!("{}|{}|{}|{date}", self.catalog.id, self.providers.join(","), self.genre)
    }

    fn key_at(&self, offset: Option<i64>) -> String {
        format!("{}|{}", self.key(), offset.map_or_else(|| "NaN".to_owned(), |offset| offset.to_string()))
    }
}

impl Catalogs {
    pub fn new(
        ids: Arc<dyn IdRepository>,
        metadata: Arc<dyn MetadataSource>,
        store: Option<Arc<dyn CacheStore>>,
        metrics: Metrics,
        settings: Settings,
    ) -> Self {
        let limiter = Limiter::new(settings.max_concurrent, settings.queue_size, metrics.clone());
        Self { ids, metadata, store, metrics, limiter, settings }
    }

    pub fn repository(&self) -> &dyn IdRepository {
        self.ids.as_ref()
    }

    pub async fn catalog(&self, id: &str, extra: &Extra) -> Result<CatalogResponse, HandlerError> {
        self.catalog_at(id, extra, Utc::now()).await
    }

    pub async fn catalog_at(
        &self,
        id: &str,
        extra: &Extra,
        now: DateTime<Utc>,
    ) -> Result<CatalogResponse, HandlerError> {
        let offset = parse_int(extra.skip.as_deref().filter(|skip| !skip.is_empty()).unwrap_or("0"));
        let genre = extra.genre.as_deref().filter(|genre| !genre.is_empty()).unwrap_or(DEFAULT_GENRE);
        tracing::info!(
            "Incoming catalog {id} request with genre={genre} and skip={}",
            offset.map_or_else(|| "NaN".to_owned(), |offset| offset.to_string())
        );
        let Some(catalog) = find_catalog(id) else {
            self.metrics.catalog_request("unknown", "not_found");
            return Err(HandlerError::UnknownCatalog(id.to_owned()));
        };
        let providers: Vec<String> = DEFAULT_PROVIDERS.iter().map(|provider| (*provider).to_owned()).collect();
        let page = Page { catalog, providers: &providers, genre: normalize_genre(genre), offset, now };
        let result = self.limiter.run(self.cached("catalog", &page.key_at(offset), self.build(&page))).await;
        Ok(match result {
            Ok(metas) => {
                self.metrics.catalog_request(catalog.id, if metas.is_empty() { "empty" } else { "ok" });
                CatalogResponse {
                    metas,
                    cache_max_age: self.settings.cache_max_age,
                    stale_revalidate: Some(STALE_REVALIDATE_AGE),
                    stale_error: Some(STALE_ERROR_AGE),
                }
            }
            Err(error) => {
                self.metrics.catalog_request(catalog.id, error.outcome());
                tracing::warn!("Failed retrieving catalog {id}: {error}");
                CatalogResponse {
                    metas: Vec::new(),
                    cache_max_age: EMPTY_CACHE_MAX_AGE,
                    stale_revalidate: None,
                    stale_error: None,
                }
            }
        })
    }

    async fn build(&self, page: &Page<'_>) -> Result<Vec<Value>, CatalogError> {
        let cursor = self.cursor(page).await?;
        let query = IdQuery {
            kind: page.catalog.kind,
            providers: page.providers.to_vec(),
            range: date_range(page.genre, page.now),
        };
        let ids_key = format!("ids|{}", page.key());
        let ids: Vec<String> = self.cached("ids", &ids_key, async { Ok(self.ids.top_ids(&query).await?) }).await?;
        let start = cursor.and_then(|cursor| ids.iter().position(|id| *id == cursor)).map_or(0, |index| index + 1);
        let mut metas = self.metadata.metas(&ids[start..], page.catalog.kind).await?;
        metas.truncate(page.catalog.page_size);
        Ok(metas)
    }

    async fn cursor(&self, page: &Page<'_>) -> Result<Option<String>, CatalogError> {
        if page.offset == Some(0) {
            return Ok(None);
        }
        let previous = page.offset.map(|offset| offset.saturating_sub(page.catalog.page_size as i64));
        let metas: Vec<Value> =
            self.lookup("catalog", &page.key_at(previous)).await?.ok_or(CatalogError::CursorNotFound)?;
        metas
            .last()
            .and_then(|meta| meta.get("id"))
            .and_then(Value::as_str)
            .map(|id| id.replacen("kitsu:", "", 1))
            .map(Some)
            .ok_or(CatalogError::CursorNotFound)
    }

    async fn lookup<T: DeserializeOwned>(&self, cache: &str, key: &str) -> Result<Option<T>, CatalogError> {
        let Some(store) = &self.store else {
            return Ok(None);
        };
        let timer = self.metrics.cache_timer("get");
        let stored = store.get(key).await;
        timer.finish();
        let hit = stored?.and_then(|value| serde_json::from_value(value).ok());
        self.metrics.cache_result(cache, if hit.is_some() { "hit" } else { "miss" });
        Ok(hit)
    }

    async fn cached<T, F>(&self, cache: &str, key: &str, fetch: F) -> Result<T, CatalogError>
    where
        T: Serialize + DeserializeOwned,
        F: Future<Output = Result<T, CatalogError>>,
    {
        if let Some(hit) = self.lookup(cache, key).await? {
            return Ok(hit);
        }
        let value = fetch.await?;
        if let (Some(store), Ok(json)) = (&self.store, serde_json::to_value(&value)) {
            let timer = self.metrics.cache_timer("set");
            let _ = store.set(key, &json, CATALOG_TTL).await;
            timer.finish();
        }
        Ok(value)
    }
}

fn parse_int(raw: &str) -> Option<i64> {
    let trimmed = raw.trim_start();
    let (negative, digits) = match trimmed.as_bytes().first() {
        Some(b'-') => (true, &trimmed[1..]),
        Some(b'+') => (false, &trimmed[1..]),
        _ => (false, trimmed),
    };
    let length = digits.bytes().take_while(u8::is_ascii_digit).count();
    if length == 0 {
        return None;
    }
    let magnitude = digits[..length].parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -magnitude } else { magnitude })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{
        application::testing::{FakeIds, FakeMetadata, FakeStore},
        domain::ContentType,
    };

    struct Fixture {
        catalogs: Catalogs,
        ids: Arc<FakeIds>,
        metadata: Arc<FakeMetadata>,
        store: Arc<FakeStore>,
        metrics: Metrics,
    }

    fn fixture(count: usize, with_store: bool) -> Fixture {
        let ids = Arc::new(FakeIds::with_count(count));
        let metadata = Arc::new(FakeMetadata::default());
        let store = Arc::new(FakeStore::default());
        let metrics = Metrics::new();
        let catalogs = Catalogs::new(
            Arc::clone(&ids) as Arc<dyn IdRepository>,
            Arc::clone(&metadata) as Arc<dyn MetadataSource>,
            with_store.then(|| Arc::clone(&store) as Arc<dyn CacheStore>),
            metrics.clone(),
            Settings::default(),
        );
        Fixture { catalogs, ids, metadata, store, metrics }
    }

    fn now() -> DateTime<Utc> {
        "2026-10-24T12:00:00Z".parse().unwrap()
    }

    fn extra(genre: Option<&str>, skip: Option<&str>) -> Extra {
        Extra { genre: genre.map(str::to_owned), skip: skip.map(str::to_owned) }
    }

    fn meta_ids(response: &CatalogResponse) -> Vec<String> {
        response.metas.iter().map(|meta| meta["id"].as_str().unwrap().to_owned()).collect()
    }

    #[tokio::test]
    async fn returns_the_first_page_with_cache_hints() {
        let fixture = fixture(45, true);
        let response = fixture.catalogs.catalog_at("top-movies", &Extra::default(), now()).await.unwrap();
        assert_eq!(meta_ids(&response).len(), 20);
        assert_eq!(meta_ids(&response)[0], "tt1");
        assert_eq!(response.cache_max_age, 4 * 60 * 60);
        assert_eq!(response.stale_revalidate, Some(4 * 60 * 60));
        assert_eq!(response.stale_error, Some(7 * 24 * 60 * 60));
    }

    #[tokio::test]
    async fn queries_ids_with_the_genre_range_and_default_providers() {
        let fixture = fixture(3, false);
        fixture.catalogs.catalog_at("top-anime", &extra(Some("Yesterday"), None), now()).await.unwrap();
        let calls = fixture.ids.calls.lock().unwrap();
        assert_eq!(calls[0].kind, ContentType::Anime);
        assert_eq!(calls[0].providers.len(), DEFAULT_PROVIDERS.len());
        assert_eq!(calls[0].range.unwrap().start.to_rfc3339(), "2026-10-23T00:00:00+00:00");
    }

    #[tokio::test]
    async fn pages_continue_after_the_last_cached_meta() {
        let fixture = fixture(45, true);
        fixture.catalogs.catalog_at("top-movies", &Extra::default(), now()).await.unwrap();
        let second = fixture.catalogs.catalog_at("top-movies", &extra(None, Some("20")), now()).await.unwrap();
        assert_eq!(meta_ids(&second)[0], "tt21");
        assert_eq!(meta_ids(&second).len(), 20);
        let third = fixture.catalogs.catalog_at("top-movies", &extra(None, Some("40")), now()).await.unwrap();
        assert_eq!(meta_ids(&third), ["tt41", "tt42", "tt43", "tt44", "tt45"]);
        assert_eq!(fixture.ids.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn anime_cursors_drop_the_kitsu_prefix() {
        let fixture = fixture(0, true);
        fixture.store.entries.lock().unwrap().insert(
            "top-anime|1337x,AniDex,EXT,EZTV,HorribleSubs,KickassTorrents,MagnetDL,NyaaSi,RARBG,ThePirateBay,TokyoTosho,TorrentGalaxy,YTS,nekoBT|default|2026-10-24|0".to_owned(),
            json!([{ "id": "kitsu:7" }]),
        );
        let ids = Arc::new(FakeIds { ids: vec!["5".into(), "7".into(), "9".into()], ..FakeIds::default() });
        let catalogs = Catalogs::new(
            ids,
            Arc::clone(&fixture.metadata) as Arc<dyn MetadataSource>,
            Some(Arc::clone(&fixture.store) as Arc<dyn CacheStore>),
            Metrics::new(),
            Settings::default(),
        );
        let response = catalogs.catalog_at("top-anime", &extra(None, Some("20")), now()).await.unwrap();
        assert_eq!(meta_ids(&response), ["9"]);
    }

    #[tokio::test]
    async fn a_missing_cursor_degrades_to_an_empty_page() {
        let fixture = fixture(45, true);
        let response = fixture.catalogs.catalog_at("top-movies", &extra(None, Some("20")), now()).await.unwrap();
        assert_eq!(response.metas, Vec::<Value>::new());
        assert_eq!(response.cache_max_age, 30 * 60);
        assert_eq!(response.stale_revalidate, None);
        assert!(fixture.store.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn skip_without_a_store_cannot_find_a_cursor() {
        let fixture = fixture(45, false);
        let response = fixture.catalogs.catalog_at("top-movies", &extra(None, Some("20")), now()).await.unwrap();
        assert_eq!(response.metas, Vec::<Value>::new());
    }

    #[tokio::test]
    async fn unparsable_skip_degrades_to_an_empty_page() {
        let fixture = fixture(45, true);
        let response = fixture.catalogs.catalog_at("top-movies", &extra(None, Some("abc")), now()).await.unwrap();
        assert_eq!(response.metas, Vec::<Value>::new());
    }

    #[tokio::test]
    async fn second_request_is_served_from_the_store() {
        let fixture = fixture(45, true);
        let first = fixture.catalogs.catalog_at("top-series", &Extra::default(), now()).await.unwrap();
        let second = fixture.catalogs.catalog_at("top-series", &Extra::default(), now()).await.unwrap();
        assert_eq!(meta_ids(&first), meta_ids(&second));
        assert_eq!(fixture.metadata.calls.lock().unwrap().len(), 1);
        let entries = fixture.store.entries.lock().unwrap();
        assert!(entries.keys().any(|key| key.starts_with("ids|top-series|")));
        assert!(entries.keys().any(|key| key.starts_with("top-series|") && key.ends_with("|default|2026-10-24|0")));
    }

    #[tokio::test]
    async fn unknown_genres_share_the_default_cache_entries() {
        let fixture = fixture(45, true);
        let bogus = fixture.catalogs.catalog_at("top-movies", &extra(Some("Bogus"), None), now()).await.unwrap();
        let other = fixture.catalogs.catalog_at("top-movies", &extra(Some("Other"), None), now()).await.unwrap();
        let default = fixture.catalogs.catalog_at("top-movies", &Extra::default(), now()).await.unwrap();
        assert_eq!(meta_ids(&bogus), meta_ids(&default));
        assert_eq!(meta_ids(&other), meta_ids(&default));
        assert_eq!(fixture.ids.calls.lock().unwrap().len(), 1);
        assert_eq!(fixture.store.entries.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn known_genres_keep_their_own_cache_entries() {
        let fixture = fixture(45, true);
        fixture.catalogs.catalog_at("top-movies", &extra(Some("This Week"), None), now()).await.unwrap();
        fixture.catalogs.catalog_at("top-movies", &Extra::default(), now()).await.unwrap();
        assert_eq!(fixture.ids.calls.lock().unwrap().len(), 2);
        assert!(fixture.store.entries.lock().unwrap().keys().any(|key| key.contains("|This Week|2026-10-24")));
    }

    #[tokio::test]
    async fn ids_are_shared_between_pages_of_the_same_day() {
        let fixture = fixture(45, true);
        fixture.catalogs.catalog_at("top-movies", &Extra::default(), now()).await.unwrap();
        fixture.catalogs.catalog_at("top-movies", &extra(None, Some("20")), now()).await.unwrap();
        assert_eq!(fixture.ids.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn repository_failures_degrade_to_an_empty_page() {
        let ids = Arc::new(FakeIds { fail: true, ..FakeIds::default() });
        let metrics = Metrics::new();
        let catalogs =
            Catalogs::new(ids, Arc::new(FakeMetadata::default()), None, metrics.clone(), Settings::default());
        let response = catalogs.catalog_at("top-movies", &Extra::default(), now()).await.unwrap();
        assert_eq!(response.metas, Vec::<Value>::new());
        assert_eq!(response.cache_max_age, 30 * 60);
        assert!(outcome_line(&metrics, "top-movies", "error"));
    }

    fn outcome_line(metrics: &Metrics, catalog: &str, outcome: &str) -> bool {
        let series = format!(r#"catalog_requests_total{{catalog="{catalog}",outcome="{outcome}","#);
        metrics.render().lines().any(|line| line.starts_with(&series) && line.ends_with(" 1"))
    }

    #[tokio::test]
    async fn counts_ok_empty_degraded_and_not_found_outcomes() {
        let fixture = fixture(45, true);
        let catalogs = &fixture.catalogs;
        catalogs.catalog_at("top-movies", &Extra::default(), now()).await.unwrap();
        catalogs.catalog_at("top-series", &extra(None, Some("20")), now()).await.unwrap();
        catalogs.catalog_at("top-tv", &Extra::default(), now()).await.unwrap_err();
        assert!(outcome_line(&fixture.metrics, "top-movies", "ok"));
        assert!(outcome_line(&fixture.metrics, "top-series", "degraded"));
        assert!(outcome_line(&fixture.metrics, "unknown", "not_found"));
        let empty = self::fixture(0, false);
        empty.catalogs.catalog_at("top-anime", &Extra::default(), now()).await.unwrap();
        assert!(outcome_line(&empty.metrics, "top-anime", "empty"));
    }

    #[tokio::test]
    async fn unknown_catalogs_are_a_handler_error() {
        let fixture = fixture(1, false);
        let error = fixture.catalogs.catalog_at("top-tv", &Extra::default(), now()).await.unwrap_err();
        assert_eq!(error.to_string(), "No catalog found for with id: top-tv");
    }

    #[test]
    fn serializes_cache_hints_only_when_present() {
        let empty = CatalogResponse { metas: vec![], cache_max_age: 1800, stale_revalidate: None, stale_error: None };
        assert_eq!(serde_json::to_string(&empty).unwrap(), r#"{"metas":[],"cacheMaxAge":1800}"#);
        let full = CatalogResponse { metas: vec![], cache_max_age: 1, stale_revalidate: Some(2), stale_error: Some(3) };
        assert_eq!(
            serde_json::to_string(&full).unwrap(),
            r#"{"metas":[],"cacheMaxAge":1,"staleRevalidate":2,"staleError":3}"#
        );
    }

    #[test]
    fn parses_skip_like_parse_int() {
        assert_eq!(parse_int("20"), Some(20));
        assert_eq!(parse_int(" 20abc"), Some(20));
        assert_eq!(parse_int("-20"), Some(-20));
        assert_eq!(parse_int("+5"), Some(5));
        assert_eq!(parse_int("0x10"), Some(0));
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_int("-"), None);
    }
}
