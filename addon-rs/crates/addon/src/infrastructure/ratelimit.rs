use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use parking_lot::Mutex;
use redis::{
    Client, RedisError,
    aio::{ConnectionManager, ConnectionManagerConfig},
};
use tokio::{sync::OnceCell, task::JoinHandle, time::timeout};
use tokio_util::sync::CancellationToken;

use crate::infrastructure::metrics::Metrics;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const LIMIT: i64 = 5000;
const KEY_PREFIX: &str = "torrentio:ratelimit:";
const FLUSH_INTERVAL: Duration = Duration::from_secs(30);
const CONNECTION_TIMEOUT: Duration = Duration::from_millis(500);
const OPERATION_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, thiserror::Error)]
enum SyncError {
    #[error(transparent)]
    Redis(#[from] RedisError),
    #[error("timed out")]
    TimedOut,
}

#[derive(Default)]
struct Hits {
    total: i64,
    unsynced: i64,
}

struct Window {
    day: u64,
    clients: HashMap<String, Hits>,
    dirty: Vec<String>,
}

struct Batch {
    day: u64,
    items: Vec<(String, i64)>,
}

impl Window {
    fn new(day: u64) -> Self {
        Self { day, clients: HashMap::new(), dirty: Vec::new() }
    }

    fn hit(&mut self, client: &str) -> i64 {
        if let Some(hits) = self.clients.get_mut(client) {
            if hits.unsynced == 0 {
                self.dirty.push(client.to_owned());
            }
            hits.total += 1;
            hits.unsynced += 1;
            return hits.total;
        }
        self.clients.insert(client.to_owned(), Hits { total: 1, unsynced: 1 });
        self.dirty.push(client.to_owned());
        1
    }

    fn take(&mut self) -> Batch {
        let items = std::mem::take(&mut self.dirty)
            .into_iter()
            .filter_map(|client| {
                let sent = std::mem::take(&mut self.clients.get_mut(&client)?.unsynced);
                (sent != 0).then_some((client, sent))
            })
            .collect();
        Batch { day: self.day, items }
    }

    fn restore(&mut self, batch: &Batch) {
        for (client, sent) in &batch.items {
            let hits = self.clients.entry(client.clone()).or_default();
            if hits.unsynced == 0 {
                self.dirty.push(client.clone());
            }
            hits.unsynced += sent;
        }
    }

    fn sync(&mut self, batch: &Batch, totals: &[i64]) {
        for ((client, _), total) in batch.items.iter().zip(totals) {
            if let Some(hits) = self.clients.get_mut(client) {
                hits.total = total + hits.unsynced;
            }
        }
    }
}

struct State {
    window: Window,
    retired: Vec<Batch>,
}

struct Redis {
    client: Client,
    connection: OnceCell<ConnectionManager>,
}

struct Inner {
    state: Mutex<State>,
    redis: Option<Redis>,
    metrics: Metrics,
}

pub struct SyncTask {
    stop: CancellationToken,
    handle: JoinHandle<()>,
}

impl SyncTask {
    pub async fn stop(self) {
        self.stop.cancel();
        let _ = self.handle.await;
    }
}

#[derive(Clone)]
pub struct RateLimiter {
    inner: Arc<Inner>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(0))
}

impl RateLimiter {
    pub fn new(url: Option<&str>, metrics: Metrics) -> Self {
        let redis = url
            .and_then(|url| Client::open(url).inspect_err(|error| tracing::error!(%error, "Redis client error")).ok())
            .map(|client| Redis { client, connection: OnceCell::new() });
        let state = State { window: Window::new(now_ms() / DAY_MS), retired: Vec::new() };
        Self { inner: Arc::new(Inner { state: Mutex::new(state), redis, metrics }) }
    }

    pub fn allow(&self, client: &str) -> bool {
        self.allow_at(client, now_ms())
    }

    fn allow_at(&self, client: &str, now: u64) -> bool {
        let mut state = self.inner.state.lock();
        let day = now / DAY_MS;
        if day > state.window.day {
            let mut previous = std::mem::replace(&mut state.window, Window::new(day));
            let leftover = previous.take();
            if self.inner.redis.is_some() && !leftover.items.is_empty() {
                state.retired.push(leftover);
            }
        }
        state.window.hit(client) <= LIMIT
    }

    pub fn spawn_sync(&self) -> SyncTask {
        let limiter = self.clone();
        let stop = CancellationToken::new();
        let stopped = stop.clone();
        let handle = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            ticker.tick().await;
            loop {
                tokio::select! {
                    () = stopped.cancelled() => break,
                    _ = ticker.tick() => limiter.flush().await,
                }
            }
        });
        SyncTask { stop, handle }
    }

    pub async fn flush(&self) {
        let Some(redis) = &self.inner.redis else {
            return;
        };
        let mut batches = {
            let mut state = self.inner.state.lock();
            let mut batches = std::mem::take(&mut state.retired);
            batches.push(state.window.take());
            batches
        };
        batches.retain(|batch| !batch.items.is_empty());
        let mut batches = batches.into_iter();
        while let Some(batch) = batches.next() {
            match timeout(OPERATION_TIMEOUT, send(redis, &batch)).await.unwrap_or(Err(SyncError::TimedOut)) {
                Ok(totals) => self.synced(&batch, &totals),
                Err(error) => {
                    self.inner.metrics.rate_limiter_store_error();
                    tracing::warn!(%error, "Rate limiter sync failed");
                    self.failed(batch);
                    batches.for_each(|rest| self.failed(rest));
                    break;
                }
            }
        }
    }

    fn synced(&self, batch: &Batch, totals: &[i64]) {
        let mut state = self.inner.state.lock();
        if state.window.day == batch.day {
            state.window.sync(batch, totals);
        }
    }

    fn failed(&self, batch: Batch) {
        let mut state = self.inner.state.lock();
        if state.window.day == batch.day {
            state.window.restore(&batch);
        } else {
            state.retired.push(batch);
        }
    }
}

async fn send(redis: &Redis, batch: &Batch) -> Result<Vec<i64>, SyncError> {
    let mut connection = redis
        .connection
        .get_or_try_init(|| {
            let config = ConnectionManagerConfig::new().set_connection_timeout(CONNECTION_TIMEOUT);
            ConnectionManager::new_with_config(redis.client.clone(), config)
        })
        .await?
        .clone();
    let hash = format!("{KEY_PREFIX}{}", batch.day);
    let mut pipeline = redis::pipe();
    pipeline.atomic();
    for (client, sent) in &batch.items {
        pipeline.hincr(&hash, client, *sent);
    }
    pipeline.cmd("PEXPIREAT").arg(&hash).arg((batch.day + 2) * DAY_MS).ignore();
    Ok(pipeline.query_async(&mut connection).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limiter(url: Option<&str>) -> RateLimiter {
        RateLimiter::new(url, Metrics::new())
    }

    fn today() -> u64 {
        now_ms() / DAY_MS
    }

    fn at(day: u64) -> u64 {
        day * DAY_MS
    }

    #[test]
    fn allows_up_to_the_limit_then_blocks() {
        let limiter = limiter(None);
        for _ in 0..LIMIT {
            assert!(limiter.allow_at("1.1.1.1", at(today())));
        }
        assert!(!limiter.allow_at("1.1.1.1", at(today())));
        assert!(limiter.allow_at("2.2.2.2", at(today())));
    }

    #[test]
    fn next_day_starts_a_fresh_count_and_retires_the_old_one() {
        let limiter = limiter(Some("redis://127.0.0.1:1"));
        for _ in 0..=LIMIT {
            limiter.allow_at("1.1.1.1", at(today()));
        }
        assert!(limiter.allow_at("1.1.1.1", at(today() + 1)));
        let state = limiter.inner.state.lock();
        assert_eq!(state.retired.len(), 1);
        assert_eq!(state.retired[0].day, today());
        assert_eq!(state.retired[0].items, vec![("1.1.1.1".to_owned(), LIMIT + 1)]);
    }

    #[test]
    fn clock_stepping_back_does_not_reset_counts() {
        let limiter = limiter(None);
        limiter.allow_at("1.1.1.1", at(today() + 1));
        limiter.allow_at("1.1.1.1", at(today()));
        let mut state = limiter.inner.state.lock();
        assert_eq!(state.window.day, today() + 1);
        assert_eq!(state.window.take().items, vec![("1.1.1.1".to_owned(), 2)]);
    }

    #[test]
    fn rollover_without_redis_retires_nothing() {
        let limiter = limiter(None);
        limiter.allow_at("1.1.1.1", at(today()));
        limiter.allow_at("1.1.1.1", at(today() + 1));
        assert_eq!(limiter.inner.state.lock().retired.len(), 0);
    }

    #[test]
    fn sync_replaces_total_with_the_shared_one_plus_newer_hits() {
        let mut window = Window::new(1);
        window.hit("a");
        window.hit("a");
        let batch = window.take();
        window.hit("a");
        window.sync(&batch, &[100]);
        assert_eq!(window.hit("a"), 102);
    }

    #[test]
    fn take_moves_hits_out_and_restore_puts_them_back() {
        let mut window = Window::new(1);
        window.hit("a");
        window.hit("b");
        let batch = window.take();
        assert_eq!(batch.items.len(), 2);
        assert_eq!(window.take().items.len(), 0);
        window.hit("a");
        window.restore(&batch);
        let mut again = window.take().items;
        again.sort();
        assert_eq!(again, vec![("a".to_owned(), 2), ("b".to_owned(), 1)]);
    }

    #[tokio::test]
    async fn stopping_the_sync_task_waits_for_it_to_finish() {
        let limiter = limiter(None);
        let task = limiter.spawn_sync();
        timeout(Duration::from_secs(1), task.stop()).await.expect("stopped");
    }

    #[tokio::test]
    async fn failed_flush_keeps_counts_and_records_the_error() {
        let limiter = limiter(Some("redis://127.0.0.1:1"));
        limiter.allow("1.1.1.1");
        limiter.allow("1.1.1.1");
        limiter.flush().await;
        let mut state = limiter.inner.state.lock();
        assert_eq!(state.window.take().items, vec![("1.1.1.1".to_owned(), 2)]);
    }
}
