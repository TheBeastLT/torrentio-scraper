use std::{collections::HashMap, future::Future, sync::Arc, time::Duration};

use moka::{Expiry, future::Cache as Moka};
use serde_json::Value;
use sysinfo::System;
use tokio::{sync::Semaphore, time::timeout};
use tokio_util::task::TaskTracker;

use crate::{
    domain::stream::Stream,
    infrastructure::metrics::Metrics,
    infrastructure::store::Store,
    providers::{Resolved, support::is_truthy},
};

const CACHE_READ_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_BACKGROUND_WRITES: usize = 256;
const DRAIN_TIMEOUT: Duration = Duration::from_secs(10);

const STREAM_KEY_PREFIX: &str = "torrentio-addon|stream";
const AVAILABILITY_KEY_PREFIX: &str = "torrentio-addon|availability";
const RESOLVED_URL_KEY_PREFIX: &str = "torrentio-addon|resolved";

const STREAM_TTL: Duration = Duration::from_secs(3 * 24 * 60 * 60);
const STREAM_MEM_TTL: Duration = Duration::from_secs(2 * 60 * 60);
const STREAM_EMPTY_TTL: Duration = Duration::from_secs(60);
const RESOLVED_URL_TTL: Duration = Duration::from_secs(3 * 60 * 60);
const AVAILABILITY_TTL: Duration = Duration::from_secs(14 * 24 * 60 * 60);
const INFRINGING_TTL: Duration = Duration::from_secs(60 * 24 * 60 * 60);
const MESSAGE_VIDEO_URL_TTL: Duration = Duration::from_secs(60);

const STREAM_ENTRY_BYTES: u64 = 40 * 1024;
const DEFAULT_STREAM_MEM_FRACTION: f64 = 0.25;
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
    streams: Moka<String, Timed<Arc<Vec<Stream>>>>,
    resolved: Moka<String, Timed<Resolved>>,
    stores: Stores,
    tasks: TaskTracker,
    write_permits: Arc<Semaphore>,
}

fn stream_lru_size() -> u64 {
    if let Some(size) = std::env::var("STREAM_LRU_SIZE").ok().and_then(|value| value.parse().ok()) {
        return size;
    }
    let fraction = std::env::var("CACHE_MEM_FRACTION")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_STREAM_MEM_FRACTION);
    let mut system = System::new();
    system.refresh_memory();
    let by_memory = (system.available_memory() as f64 * fraction) as u64 / STREAM_ENTRY_BYTES;
    by_memory.clamp(5000, 15_000)
}

impl Cache {
    pub fn new(metrics: Metrics, stores: Stores) -> Self {
        let stream_size = stream_lru_size();
        tracing::info!(stream = stream_size, resolved = RESOLVED_LRU_SIZE, "Cache LRU sizes");
        Self {
            metrics,
            streams: Moka::builder().max_capacity(stream_size).expire_after(PerEntryTtl).build(),
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
            self.metrics.cache_result("stream", "memory");
            return Ok(found.value);
        }
        if let Some(store) = &self.stores.streams {
            let timer = self.metrics.cache_timer("get");
            let stored =
                timeout(CACHE_READ_TIMEOUT, store.get::<Vec<Stream>>(&key)).await.ok().and_then(Result::ok).flatten();
            timer.finish();
            if let Some(streams) = stored {
                self.metrics.cache_result("stream", "store");
                let streams = Arc::new(streams);
                self.remember_streams(key, Arc::clone(&streams)).await;
                return Ok(streams);
            }
        }
        self.metrics.cache_result("stream", "miss");
        let streams = Arc::new(method().await?);
        if let Some(store) = &self.stores.streams {
            let ttl = if streams.is_empty() { STREAM_EMPTY_TTL } else { STREAM_TTL };
            let store = store.clone();
            let value = Arc::clone(&streams);
            let store_key = key.clone();
            self.background(async move { write(&store, &store_key, value.as_ref(), ttl).await });
        }
        self.remember_streams(key, Arc::clone(&streams)).await;
        Ok(streams)
    }

    async fn remember_streams(&self, key: String, streams: Arc<Vec<Stream>>) {
        let ttl = if streams.is_empty() { STREAM_EMPTY_TTL } else { STREAM_MEM_TTL };
        self.streams.insert(key, Timed { value: streams, ttl }).await;
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
                let mut entries = store.get::<Vec<Vec<i64>>>(&key).await?.unwrap_or_default();
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
                let Some(mut entries) = store.get::<Vec<Vec<i64>>>(&key).await? else {
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

async fn write<T: serde::Serialize>(store: &Store, key: &str, value: &T, ttl: Duration) {
    log_write_error(key, store.set(key, value, ttl).await);
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
