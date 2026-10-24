use std::{collections::HashMap, future::Future, sync::Arc, time::Duration};

use moka::{Expiry, future::Cache as Moka};
use mongodb::bson::DateTime;
use serde_json::Value;
use tokio::{sync::Semaphore, task::JoinHandle, time::timeout};
use tokio_util::task::TaskTracker;

use crate::{
    domain::stream::Stream,
    infrastructure::metrics::Metrics,
    infrastructure::store::{Packed, Store, StoreError},
    providers::{Resolved, support::is_truthy},
};

const CACHE_READ_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_BACKGROUND_WRITES: usize = 256;
const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);
const INVALIDATION_POLL: Duration = Duration::from_secs(5);
const INVALIDATION_RETENTION: Duration = Duration::from_secs(45 * 60);

const STREAM_KEY_PREFIX: &str = "torrentio-addon|stream";
const AVAILABILITY_KEY_PREFIX: &str = "torrentio-addon|availability";
const RESOLVED_URL_KEY_PREFIX: &str = "torrentio-addon|resolved";

const STREAM_TTL: Duration = Duration::from_secs(3 * 24 * 60 * 60);
const STREAM_MEM_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const STREAM_EMPTY_TTL: Duration = Duration::from_secs(60);
const RESOLVED_URL_TTL: Duration = Duration::from_secs(3 * 60 * 60);
const AVAILABILITY_TTL: Duration = Duration::from_secs(14 * 24 * 60 * 60);
const INFRINGING_TTL: Duration = Duration::from_secs(60 * 24 * 60 * 60);
const MESSAGE_VIDEO_URL_TTL: Duration = Duration::from_secs(60);

const DEFAULT_STREAM_CACHE_MB: u64 = 600;
const RESOLVED_LRU_SIZE: u64 = 20_000;

#[derive(Clone)]
struct Timed<T> {
    value: T,
    ttl: Duration,
}

struct PerEntryTtl;

impl<K, T> Expiry<K, Timed<T>> for PerEntryTtl {
    fn expire_after_create(&self, _key: &K, value: &Timed<T>, _created_at: std::time::Instant) -> Option<Duration> {
        Some(value.ttl)
    }
}

pub struct Stores {
    pub streams: Option<Store>,
    pub availability: Option<Store>,
}

pub struct Cache {
    metrics: Metrics,
    streams: Moka<String, Timed<Packed>>,
    resolved: Moka<String, Timed<Resolved>>,
    stores: Stores,
    tasks: TaskTracker,
    write_permits: Arc<Semaphore>,
}

fn stream_cache_bytes() -> u64 {
    let megabytes =
        std::env::var("STREAM_CACHE_MB").ok().and_then(|value| value.parse().ok()).unwrap_or(DEFAULT_STREAM_CACHE_MB);
    megabytes * 1024 * 1024
}

impl Cache {
    pub fn new(metrics: Metrics, stores: Stores) -> Self {
        let stream_bytes = stream_cache_bytes();
        tracing::info!(stream_mb = stream_bytes / 1024 / 1024, resolved = RESOLVED_LRU_SIZE, "Cache sizes");
        Self {
            metrics,
            streams: Moka::<String, Timed<Packed>>::builder()
                .max_capacity(stream_bytes)
                .weigher(|key, entry| u32::try_from(key.len() + entry.value.len()).unwrap_or(u32::MAX))
                .expire_after(PerEntryTtl)
                .build(),
            resolved: Moka::builder().max_capacity(RESOLVED_LRU_SIZE).expire_after(PerEntryTtl).build(),
            stores,
            tasks: TaskTracker::new(),
            write_permits: Arc::new(Semaphore::new(MAX_BACKGROUND_WRITES)),
        }
    }

    fn background(&self, work: impl Future<Output = ()> + Send + 'static) {
        let Ok(permit) = Arc::clone(&self.write_permits).try_acquire_owned() else {
            tracing::warn!("Cache write dropped, too many writes in flight");
            return;
        };
        self.tasks.spawn(async move {
            work.await;
            drop(permit);
        });
    }

    pub fn watch_invalidations(self: &Arc<Self>, store: Store) -> JoinHandle<()> {
        let cache = Arc::clone(self);
        tokio::spawn(async move {
            let mut cursor = DateTime::now();
            let mut last_synced = std::time::Instant::now();
            let mut ticker = tokio::time::interval(INVALIDATION_POLL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticker.tick().await;
                match timeout(CACHE_READ_TIMEOUT, store.expiring_after(cursor)).await {
                    Ok(Ok(invalidated)) => {
                        if last_synced.elapsed() > INVALIDATION_RETENTION {
                            cache.streams.invalidate_all();
                        }
                        last_synced = std::time::Instant::now();
                        for (key, expires_at) in invalidated {
                            cache.streams.invalidate(&key).await;
                            cursor = cursor.max(expires_at);
                        }
                    }
                    Ok(Err(error)) => tracing::warn!(%error, "Failed to poll cache invalidations"),
                    Err(_) => tracing::warn!("Timed out polling cache invalidations"),
                }
            }
        })
    }

    pub fn observe(&self) {
        self.metrics.memory_cache("stream", Some(self.streams.weighted_size()), self.streams.entry_count());
        self.metrics.memory_cache("resolved", None, self.resolved.entry_count());
    }

    pub async fn drain(&self) {
        self.tasks.close();
        if timeout(DRAIN_TIMEOUT, self.tasks.wait()).await.is_err() {
            tracing::warn!("Timed out waiting for cache writes to finish");
        }
    }

    pub async fn wrap_stream<E, Fut>(&self, id: &str, method: impl FnOnce() -> Fut) -> Result<Arc<Vec<Stream>>, E>
    where
        Fut: Future<Output = Result<Vec<Stream>, E>>,
    {
        let key = format!("{STREAM_KEY_PREFIX}:{id}");
        if let Some(found) = self.streams.get(&key).await {
            match found.value.decode::<Vec<Stream>>() {
                Ok(streams) => {
                    self.metrics.cache_result("stream", "memory");
                    return Ok(Arc::new(streams));
                }
                Err(error) => {
                    tracing::warn!(key, %error, "Failed to decode cached streams");
                    self.streams.invalidate(&key).await;
                }
            }
        }
        if let Some(store) = &self.stores.streams {
            let timer = self.metrics.cache_timer("get");
            let stored = timeout(CACHE_READ_TIMEOUT, store.get_packed(&key)).await.ok().and_then(Result::ok).flatten();
            timer.finish();
            if let Some(packed) = stored
                && let Ok(streams) = packed.decode::<Vec<Stream>>()
            {
                self.metrics.cache_result("stream", "store");
                self.remember_streams(key, packed, streams.is_empty()).await;
                return Ok(Arc::new(streams));
            }
        }
        self.metrics.cache_result("stream", "miss");
        let streams = Arc::new(method().await?);
        match Packed::encode(streams.as_ref()) {
            Ok(packed) => {
                if let Some(store) = &self.stores.streams {
                    let ttl = if streams.is_empty() { STREAM_EMPTY_TTL } else { STREAM_TTL };
                    let store = store.clone();
                    let value = packed.clone();
                    let store_key = key.clone();
                    self.background(async move {
                        log_write_error(&store_key, store.set_packed(&store_key, &value, ttl).await);
                    });
                }
                self.remember_streams(key, packed, streams.is_empty()).await;
            }
            Err(error) => tracing::warn!(key, %error, "Failed to encode streams for the cache"),
        }
        Ok(streams)
    }

    async fn remember_streams(&self, key: String, packed: Packed, empty: bool) {
        let ttl = if empty { STREAM_EMPTY_TTL } else { STREAM_MEM_TTL };
        self.streams.insert(key, Timed { value: packed, ttl }).await;
    }

    pub async fn wrap_resolved_url<E>(
        &self,
        id: &str,
        method: impl Future<Output = Result<Resolved, E>>,
    ) -> Result<Resolved, E> {
        let key = format!("{RESOLVED_URL_KEY_PREFIX}:{id}");
        if let Some(found) = self.resolved.get(&key).await {
            self.metrics.cache_result("resolved", "memory");
            return Ok(found.value);
        }
        self.metrics.cache_result("resolved", "miss");
        let resolved = method.await?;
        let ttl = match resolved {
            Resolved::Url(_) => RESOLVED_URL_TTL,
            Resolved::Message(_) => MESSAGE_VIDEO_URL_TTL,
        };
        self.resolved.insert(key, Timed { value: resolved.clone(), ttl }).await;
        Ok(resolved)
    }

    pub fn cache_availability(&self, info_hash: &str, file_ids: &[i64]) {
        let Some(store) = self.stores.availability.clone() else { return };
        let key = format!("{AVAILABILITY_KEY_PREFIX}:{info_hash}");
        let file_ids = file_ids.to_vec();
        self.background(async move {
            let result = async {
                let mut entries = stored_entries(&store, &key).await?.unwrap_or_default();
                if !entries.contains(&file_ids) {
                    entries.push(file_ids);
                    entries.sort_by_key(|ids| std::cmp::Reverse(ids.len()));
                }
                store.set(&key, &entries, AVAILABILITY_TTL).await
            }
            .await;
            log_write_error(&key, result);
        });
    }

    pub fn remove_availability(&self, info_hash: &str, file_ids: Option<&[i64]>) {
        let Some(store) = self.stores.availability.clone() else { return };
        let key = format!("{AVAILABILITY_KEY_PREFIX}:{info_hash}");
        let file_ids = file_ids.map(<[i64]>::to_vec);
        self.background(async move {
            let result = async {
                let Some(file_ids) = file_ids else {
                    return store.delete(&key).await;
                };
                let Some(mut entries) = stored_entries(&store, &key).await? else {
                    return Ok(());
                };
                if let Some(index) = entries.iter().position(|ids| *ids == file_ids) {
                    entries.remove(index);
                    store.set(&key, &entries, AVAILABILITY_TTL).await?;
                }
                Ok(())
            }
            .await;
            log_write_error(&key, result);
        });
    }

    pub async fn cached_availability(&self, info_hashes: &[String]) -> HashMap<String, Value> {
        self.availability_many(AVAILABILITY_KEY_PREFIX.to_owned(), info_hashes).await
    }

    pub fn cache_infringing(&self, info_hash: &str) {
        let Some(store) = self.stores.availability.clone() else { return };
        let key = format!("{AVAILABILITY_KEY_PREFIX}:{info_hash}");
        self.background(async move {
            log_write_error(&key, store.set(&key, &serde_json::json!({ "infringing": true }), INFRINGING_TTL).await);
        });
    }

    pub fn cache_moch_availability(&self, moch: &str, info_hash: &str, result: Option<Value>) {
        let Some(store) = self.stores.availability.clone() else { return };
        let key = format!("{AVAILABILITY_KEY_PREFIX}:{moch}:{info_hash}");
        let value = result.unwrap_or_else(|| serde_json::json!({ "cached": true }));
        self.background(async move { log_write_error(&key, store.set(&key, &value, AVAILABILITY_TTL).await) });
    }

    pub fn remove_moch_availability(&self, moch: &str, info_hash: &str) {
        let Some(store) = self.stores.availability.clone() else { return };
        let key = format!("{AVAILABILITY_KEY_PREFIX}:{moch}:{info_hash}");
        self.background(async move { log_write_error(&key, store.delete(&key).await) });
    }

    pub async fn moch_cached_availability(&self, moch: &str, info_hashes: &[String]) -> HashMap<String, Value> {
        self.availability_many(format!("{AVAILABILITY_KEY_PREFIX}:{moch}"), info_hashes).await
    }

    async fn availability_many(&self, prefix: String, info_hashes: &[String]) -> HashMap<String, Value> {
        let Some(store) = &self.stores.availability else { return HashMap::new() };
        let keys: Vec<String> = info_hashes.iter().map(|info_hash| format!("{prefix}:{info_hash}")).collect();
        let timer = self.metrics.cache_timer("getMany");
        let result = store.get_many::<Value>(&keys).await;
        timer.finish();
        match result {
            Ok(values) => info_hashes
                .iter()
                .zip(values)
                .filter_map(|(info_hash, value)| value.filter(is_truthy).map(|value| (info_hash.clone(), value)))
                .collect(),
            Err(error) => {
                tracing::warn!(%error, "Failed retrieve availability cache");
                HashMap::new()
            }
        }
    }
}

async fn stored_entries(store: &Store, key: &str) -> Result<Option<Vec<Vec<i64>>>, StoreError> {
    Ok(store.get::<Value>(key).await?.and_then(availability_entries))
}

fn availability_entries(value: Value) -> Option<Vec<Vec<i64>>> {
    serde_json::from_value(value).ok()
}

fn log_write_error<E: std::fmt::Display>(key: &str, result: Result<(), E>) {
    if let Err(error) = result {
        tracing::warn!(key, %error, "Failed to write cache");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::static_videos::StaticResponse;

    fn cache() -> Cache {
        Cache::new(Metrics::new(), Stores { streams: None, availability: None })
    }

    async fn ttl_of(cache: &Cache, id: &str) -> Option<Duration> {
        cache.resolved.get(&format!("{RESOLVED_URL_KEY_PREFIX}:{id}")).await.map(|found| found.ttl)
    }

    #[tokio::test]
    async fn urls_are_cached_for_the_resolved_ttl() {
        let cache = cache();
        let url = Resolved::Url("https://cdn.example/a.mkv".to_owned());
        let result = cache.wrap_resolved_url("a", async { Ok::<_, String>(url.clone()) }).await;
        assert_eq!(result, Ok(url));
        assert_eq!(ttl_of(&cache, "a").await, Some(RESOLVED_URL_TTL));
    }

    #[tokio::test]
    async fn messages_are_cached_for_the_message_ttl() {
        let cache = cache();
        let message = Resolved::Message(StaticResponse::Downloading);
        let result = cache.wrap_resolved_url("b", async { Ok::<_, String>(message.clone()) }).await;
        assert_eq!(result, Ok(message));
        assert_eq!(ttl_of(&cache, "b").await, Some(MESSAGE_VIDEO_URL_TTL));
    }

    fn stream(index: usize) -> Stream {
        Stream {
            name: format!("Torrentio\n1080p {index}"),
            title: format!("Some.Movie.2020.1080p.BluRay.x264-GROUP{index}\n👤 {index} 💾 2.1 GB ⚙️ ThePirateBay"),
            info_hash: Some(format!("{index:040x}")),
            file_idx: Some(1),
            ..Stream::default()
        }
    }

    #[tokio::test]
    async fn streams_are_served_from_memory_after_the_first_call() {
        let cache = cache();
        let streams: Vec<Stream> = (0..50).map(stream).collect();
        let first = cache.wrap_stream("tt1", || async { Ok::<_, String>(streams.clone()) }).await.unwrap();
        let second = cache.wrap_stream("tt1", || async { Err::<Vec<Stream>, _>("not called".to_owned()) }).await;
        assert_eq!(*first, streams);
        assert_eq!(*second.unwrap(), streams);
    }

    #[tokio::test]
    async fn stream_entries_are_smaller_in_memory_than_their_json() {
        let streams: Arc<Vec<Stream>> = Arc::new((0..100).map(stream).collect());
        let packed = Packed::encode(streams.as_ref()).unwrap();
        let json = serde_json::to_vec(streams.as_ref()).unwrap();
        assert!(packed.len() * 3 < json.len(), "{} vs {}", packed.len(), json.len());
    }

    #[tokio::test]
    async fn memory_cache_gauges_report_entries_and_compressed_bytes() {
        let cache = cache();
        let streams: Vec<Stream> = (0..50).map(stream).collect();
        cache.wrap_stream("tt2", || async { Ok::<_, String>(streams) }).await.unwrap();
        cache.streams.run_pending_tasks().await;
        cache.observe();
        let rendered = cache.metrics.render();
        let gauge = |name: &str| -> f64 {
            rendered
                .lines()
                .find(|line| line.starts_with(&format!("{name}{{cache=\"stream\"")))
                .and_then(|line| line.rsplit(' ').next())
                .and_then(|value| value.parse().ok())
                .expect("gauge")
        };
        assert!((gauge("memory_cache_entries") - 1.0).abs() < f64::EPSILON, "{rendered}");
        let bytes = gauge("memory_cache_bytes");
        assert!(bytes > 0.0 && bytes < 20_000.0, "{bytes}");
    }

    #[test]
    fn availability_entries_ignore_values_that_are_not_lists() {
        assert_eq!(availability_entries(serde_json::json!([[1, 2], [3]])), Some(vec![vec![1, 2], vec![3]]));
        assert_eq!(availability_entries(serde_json::json!({ "infringing": true })), None);
        assert_eq!(availability_entries(serde_json::json!({ "cached": true })), None);
    }

    #[tokio::test]
    async fn errors_are_not_cached() {
        let cache = cache();
        let result = cache.wrap_resolved_url("c", async { Err::<Resolved, _>("boom".to_owned()) }).await;
        assert_eq!(result, Err("boom".to_owned()));
        assert_eq!(ttl_of(&cache, "c").await, None);
    }

    #[tokio::test]
    async fn cached_results_skip_the_method() {
        let cache = cache();
        let first = Resolved::Url("https://cdn.example/a.mkv".to_owned());
        cache.wrap_resolved_url("d", async { Ok::<_, String>(first.clone()) }).await.unwrap();
        let second =
            cache.wrap_resolved_url("d", async { Ok::<_, String>(Resolved::Message(StaticResponse::FailedRar)) }).await;
        assert_eq!(second, Ok(first));
    }
}
