use std::{
    borrow::Cow,
    collections::HashMap,
    net::Ipv6Addr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use parking_lot::Mutex;
use redis::{
    AsyncCommands, Client, RedisError,
    aio::{ConnectionManager, ConnectionManagerConfig},
};
use tokio::{sync::OnceCell, task::JoinHandle, time::timeout};
use tokio_util::sync::CancellationToken;

use crate::infrastructure::{metrics::Metrics, pressure::Pressure};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const BUDGET_PERIOD_MS: u64 = 10 * 60 * 1000;
const LIMIT: i64 = 5000;
const KEYED_MULTIPLIER: i64 = 3;
const PRESSURE_DIVISOR: i64 = 3;
const KEY_PREFIX: &str = "torrentio:ratelimit:";
const MISS_KEY_PREFIX: &str = "torrentio:ratelimit:miss:";
const EMPTY_KEY_PREFIX: &str = "torrentio:ratelimit:empty:";
const PRESSURE_KEY: &str = "torrentio:pressure";
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

#[derive(Clone, Copy, Debug)]
pub enum Budget {
    Miss,
    Empty,
}

impl Budget {
    fn label(self) -> &'static str {
        match self {
            Self::Miss => "miss",
            Self::Empty => "empty",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Budgets {
    pub enforce: bool,
    pub misses: i64,
    pub empties: i64,
    pub pressure_miss_rate: f64,
}

impl Default for Budgets {
    fn default() -> Self {
        Self { enforce: false, misses: 100, empties: 30, pressure_miss_rate: 100.0 }
    }
}

impl Budgets {
    pub fn from_env() -> Self {
        let defaults = Self::default();
        Self {
            enforce: std::env::var("STREAM_BUDGET_MODE").as_deref() == Ok("enforce"),
            misses: env_number("STREAM_MISS_BUDGET", defaults.misses),
            empties: env_number("STREAM_EMPTY_BUDGET", defaults.empties),
            pressure_miss_rate: env_number("STREAM_PRESSURE_MISS_RATE", defaults.pressure_miss_rate),
        }
    }

    fn mode(&self) -> &'static str {
        if self.enforce { "enforce" } else { "observe" }
    }

    fn limit(&self, budget: Budget, caller: Caller<'_>, pressure: bool) -> i64 {
        let base = match budget {
            Budget::Miss => self.misses,
            Budget::Empty => self.empties,
        };
        match (caller.keyed, pressure) {
            (true, _) => base * KEYED_MULTIPLIER,
            (false, true) => base / PRESSURE_DIVISOR,
            (false, false) => base,
        }
    }
}

fn env_number<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name).ok().and_then(|value| value.parse().ok()).unwrap_or(default)
}

#[derive(Clone, Copy, Debug)]
pub struct Caller<'a> {
    pub ip: &'a str,
    pub keyed: bool,
}

#[derive(Default)]
struct Hits {
    total: i64,
    unsynced: i64,
}

struct Window {
    slot: u64,
    clients: HashMap<String, Hits>,
    dirty: Vec<String>,
}

struct Batch {
    slot: u64,
    items: Vec<(String, i64)>,
}

impl Window {
    fn new(slot: u64) -> Self {
        Self { slot, clients: HashMap::new(), dirty: Vec::new() }
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
        Batch { slot: self.slot, items }
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

struct Counter {
    prefix: &'static str,
    period: u64,
    shared: bool,
    state: Mutex<State>,
}

impl Counter {
    fn new(prefix: &'static str, period: u64, shared: bool, now: u64) -> Self {
        let state = State { window: Window::new(now / period), retired: Vec::new() };
        Self { prefix, period, shared, state: Mutex::new(state) }
    }

    fn window<'a>(&self, state: &'a mut State, now: u64) -> &'a mut Window {
        let slot = now / self.period;
        if slot > state.window.slot {
            let mut previous = std::mem::replace(&mut state.window, Window::new(slot));
            let leftover = previous.take();
            if self.shared && !leftover.items.is_empty() {
                state.retired.push(leftover);
            }
        }
        &mut state.window
    }

    fn total(&self, client: &str, now: u64) -> i64 {
        let mut state = self.state.lock();
        self.window(&mut state, now).clients.get(client).map_or(0, |hits| hits.total)
    }

    fn hit(&self, client: &str, now: u64) -> i64 {
        let mut state = self.state.lock();
        self.window(&mut state, now).hit(client)
    }

    fn take(&self, now: u64) -> Vec<Batch> {
        let mut state = self.state.lock();
        let mut batches = std::mem::take(&mut state.retired);
        batches.push(state.window.take());
        batches.retain(|batch| !batch.items.is_empty() && self.expiry(batch.slot) > now);
        batches
    }

    fn expiry(&self, slot: u64) -> u64 {
        (slot + 2) * self.period
    }

    fn synced(&self, batch: &Batch, totals: &[i64]) {
        let mut state = self.state.lock();
        if state.window.slot == batch.slot {
            state.window.sync(batch, totals);
        }
    }

    fn failed(&self, batch: Batch) {
        let mut state = self.state.lock();
        if state.window.slot == batch.slot {
            state.window.restore(&batch);
        } else {
            state.retired.push(batch);
        }
    }
}

struct Redis {
    client: Client,
    connection: OnceCell<ConnectionManager>,
}

struct Inner {
    requests: Counter,
    misses: Counter,
    empties: Counter,
    budgets: Budgets,
    pressure: Mutex<Pressure>,
    under_pressure: AtomicBool,
    redis: Option<Redis>,
    metrics: Metrics,
}

impl Inner {
    fn counter(&self, budget: Budget) -> &Counter {
        match budget {
            Budget::Miss => &self.misses,
            Budget::Empty => &self.empties,
        }
    }

    fn counters(&self) -> [&Counter; 3] {
        [&self.requests, &self.misses, &self.empties]
    }
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

#[cfg(not(test))]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(0))
}

fn budget_key(ip: &str) -> Cow<'_, str> {
    match ip.parse::<Ipv6Addr>() {
        Ok(address) if address.to_ipv4_mapped().is_none() => {
            Cow::Owned(format!("{}/64", Ipv6Addr::from_bits(address.to_bits() & (u128::MAX << 64))))
        }
        _ => Cow::Borrowed(ip),
    }
}

impl RateLimiter {
    pub fn new(url: Option<&str>, budgets: Budgets, metrics: Metrics) -> Self {
        let redis = url
            .and_then(|url| Client::open(url).inspect_err(|error| tracing::error!(%error, "Redis client error")).ok())
            .map(|client| Redis { client, connection: OnceCell::new() });
        let shared = redis.is_some();
        let now = now_ms();
        let inner = Inner {
            requests: Counter::new(KEY_PREFIX, DAY_MS, shared, now),
            misses: Counter::new(MISS_KEY_PREFIX, BUDGET_PERIOD_MS, shared, now),
            empties: Counter::new(EMPTY_KEY_PREFIX, BUDGET_PERIOD_MS, shared, now),
            budgets,
            pressure: Mutex::new(Pressure::new(budgets.pressure_miss_rate)),
            under_pressure: AtomicBool::new(false),
            redis,
            metrics,
        };
        Self { inner: Arc::new(inner) }
    }

    pub fn allow(&self, client: &str) -> bool {
        self.allow_at(client, now_ms())
    }

    fn allow_at(&self, client: &str, now: u64) -> bool {
        self.inner.requests.hit(client, now) <= LIMIT
    }

    pub fn stream_allowed(&self, caller: Caller<'_>) -> bool {
        self.stream_allowed_at(caller, now_ms())
    }

    fn stream_allowed_at(&self, caller: Caller<'_>, now: u64) -> bool {
        let key = budget_key(caller.ip);
        let pressure = self.inner.under_pressure.load(Ordering::Relaxed);
        let exceeded = [Budget::Miss, Budget::Empty].into_iter().find(|budget| {
            self.inner.counter(*budget).total(&key, now) > self.inner.budgets.limit(*budget, caller, pressure)
        });
        let Some(budget) = exceeded else {
            return true;
        };
        self.inner.metrics.stream_budget_exceeded(budget.label(), self.inner.budgets.mode());
        !self.inner.budgets.enforce
    }

    pub fn charge(&self, caller: Caller<'_>, budget: Budget) {
        self.charge_at(caller, budget, now_ms());
    }

    fn charge_at(&self, caller: Caller<'_>, budget: Budget, now: u64) {
        let key = budget_key(caller.ip);
        let total = self.inner.counter(budget).hit(&key, now);
        let limit = self.inner.budgets.limit(budget, caller, self.inner.under_pressure.load(Ordering::Relaxed));
        if total == limit + 1 {
            tracing::info!(
                client = %key,
                keyed = caller.keyed,
                budget = budget.label(),
                total,
                limit,
                mode = self.inner.budgets.mode(),
                "Stream budget exceeded"
            );
        }
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
        let now = now_ms();
        let forced = match &self.inner.redis {
            Some(redis) => timeout(OPERATION_TIMEOUT, read_override(redis)).await.ok().and_then(Result::ok).flatten(),
            None => None,
        };
        self.update_pressure(now, forced);
        if let Some(redis) = &self.inner.redis {
            for counter in self.inner.counters() {
                if !self.flush_counter(redis, counter, now).await {
                    break;
                }
            }
        }
    }

    fn update_pressure(&self, now: u64, forced: Option<bool>) {
        let reading = self.inner.pressure.lock().observe(now, self.inner.metrics.stream_misses(), forced);
        if self.inner.under_pressure.swap(reading.active, Ordering::Relaxed) != reading.active {
            tracing::warn!(
                active = reading.active,
                rate = reading.rate,
                threshold = reading.threshold,
                forced,
                "Stream pressure mode changed"
            );
        }
        self.inner.metrics.stream_pressure(reading.active);
    }

    async fn flush_counter(&self, redis: &Redis, counter: &Counter, now: u64) -> bool {
        let mut batches = counter.take(now).into_iter();
        while let Some(batch) = batches.next() {
            match timeout(OPERATION_TIMEOUT, send(redis, counter, &batch)).await.unwrap_or(Err(SyncError::TimedOut)) {
                Ok(totals) => counter.synced(&batch, &totals),
                Err(error) => {
                    self.inner.metrics.rate_limiter_store_error();
                    tracing::warn!(%error, "Rate limiter sync failed");
                    counter.failed(batch);
                    batches.for_each(|rest| counter.failed(rest));
                    return false;
                }
            }
        }
        true
    }
}

async fn connect(redis: &Redis) -> Result<ConnectionManager, SyncError> {
    Ok(redis
        .connection
        .get_or_try_init(|| {
            let config = ConnectionManagerConfig::new().set_connection_timeout(CONNECTION_TIMEOUT);
            ConnectionManager::new_with_config(redis.client.clone(), config)
        })
        .await?
        .clone())
}

async fn send(redis: &Redis, counter: &Counter, batch: &Batch) -> Result<Vec<i64>, SyncError> {
    let mut connection = connect(redis).await?;
    let hash = format!("{}{}", counter.prefix, batch.slot);
    let mut pipeline = redis::pipe();
    pipeline.atomic();
    for (client, sent) in &batch.items {
        pipeline.hincr(&hash, client, *sent);
    }
    pipeline.cmd("PEXPIREAT").arg(&hash).arg(counter.expiry(batch.slot)).ignore();
    Ok(pipeline.query_async(&mut connection).await?)
}

async fn read_override(redis: &Redis) -> Result<Option<bool>, SyncError> {
    let mut connection = connect(redis).await?;
    let value: Option<String> = connection.get(PRESSURE_KEY).await?;
    Ok(value.and_then(|value| match value.as_str() {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    }))
}

#[cfg(test)]
fn now_ms() -> u64 {
    1_800_000_000_000
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANON: Caller<'static> = Caller { ip: "1.1.1.1", keyed: false };
    const KEYED: Caller<'static> = Caller { ip: "1.1.1.1", keyed: true };
    const UNREACHABLE: Option<&str> = Some("redis://127.0.0.1:1");

    fn limiter(url: Option<&str>) -> RateLimiter {
        RateLimiter::new(url, Budgets::default(), Metrics::new())
    }

    fn enforcing(misses: i64, empties: i64) -> RateLimiter {
        let budgets = Budgets { enforce: true, misses, empties, ..Budgets::default() };
        RateLimiter::new(None, budgets, Metrics::new())
    }

    fn today() -> u64 {
        now_ms() / DAY_MS
    }

    fn at(day: u64) -> u64 {
        day * DAY_MS
    }

    fn period() -> u64 {
        now_ms() / BUDGET_PERIOD_MS
    }

    fn in_period(period: u64) -> u64 {
        period * BUDGET_PERIOD_MS
    }

    fn charge(limiter: &RateLimiter, caller: Caller<'_>, budget: Budget, times: i64) {
        for _ in 0..times {
            limiter.charge(caller, budget);
        }
    }

    fn ip(ip: &'static str) -> Caller<'static> {
        Caller { ip, keyed: false }
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
        let limiter = limiter(UNREACHABLE);
        for _ in 0..=LIMIT {
            limiter.allow_at("1.1.1.1", at(today()));
        }
        assert!(limiter.allow_at("1.1.1.1", at(today() + 1)));
        let state = limiter.inner.requests.state.lock();
        assert_eq!(state.retired.len(), 1);
        assert_eq!(state.retired[0].slot, today());
        assert_eq!(state.retired[0].items, vec![("1.1.1.1".to_owned(), LIMIT + 1)]);
    }

    #[test]
    fn clock_stepping_back_does_not_reset_counts() {
        let limiter = limiter(None);
        limiter.allow_at("1.1.1.1", at(today() + 1));
        limiter.allow_at("1.1.1.1", at(today()));
        let mut state = limiter.inner.requests.state.lock();
        assert_eq!(state.window.slot, today() + 1);
        assert_eq!(state.window.take().items, vec![("1.1.1.1".to_owned(), 2)]);
    }

    #[test]
    fn rollover_without_redis_retires_nothing() {
        let limiter = limiter(None);
        limiter.allow_at("1.1.1.1", at(today()));
        limiter.allow_at("1.1.1.1", at(today() + 1));
        assert_eq!(limiter.inner.requests.state.lock().retired.len(), 0);
    }

    #[test]
    fn expired_retired_batches_are_dropped() {
        let limiter = limiter(UNREACHABLE);
        for offset in 0..3 {
            limiter.charge_at(ANON, Budget::Miss, in_period(period() + offset));
        }
        let batches = limiter.inner.misses.take(in_period(period() + 2));
        let slots: Vec<u64> = batches.iter().map(|batch| batch.slot).collect();
        assert_eq!(slots, [period() + 1, period() + 2]);
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

    #[test]
    fn budgets_allow_their_size_then_reject_when_enforcing() {
        for budget in [Budget::Miss, Budget::Empty] {
            let limiter = enforcing(3, 3);
            charge(&limiter, ANON, budget, 3);
            assert!(limiter.stream_allowed(ANON), "{budget:?}");
            charge(&limiter, ANON, budget, 1);
            assert!(!limiter.stream_allowed(ANON), "{budget:?}");
            assert!(limiter.stream_allowed(ip("2.2.2.2")), "{budget:?}");
        }
    }

    #[test]
    fn ipv6_clients_share_a_budget_per_64_prefix() {
        let limiter = enforcing(2, 100);
        charge(&limiter, ip("2001:db8:1:2::1"), Budget::Miss, 3);
        assert!(!limiter.stream_allowed(ip("2001:db8:1:2:ffff::9")));
        assert!(limiter.stream_allowed(ip("2001:db8:1:3::1")));
    }

    #[test]
    fn budget_keys_pool_only_native_ipv6() {
        assert_eq!(budget_key("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
        assert_eq!(budget_key("::ffff:203.0.113.7"), "::ffff:203.0.113.7");
        assert_eq!(budget_key("203.0.113.7"), "203.0.113.7");
        assert_eq!(budget_key(""), "");
    }

    #[test]
    fn observe_mode_allows_but_counts_the_excess() {
        let limiter = limiter(None);
        charge(&limiter, ANON, Budget::Empty, Budgets::default().empties + 1);
        assert!(limiter.stream_allowed(ANON));
        let rendered = limiter.inner.metrics.render();
        let line = rendered.lines().find(|line| line.starts_with("stream_budget_exceeded_total{")).expect("counted");
        assert!(
            line.contains("budget=\"empty\"") && line.contains("mode=\"observe\"") && line.ends_with(" 1"),
            "{line}"
        );
    }

    #[test]
    fn keyed_callers_get_three_times_the_budget() {
        let limiter = enforcing(3, 3);
        charge(&limiter, KEYED, Budget::Miss, 9);
        assert!(limiter.stream_allowed(KEYED));
        charge(&limiter, KEYED, Budget::Miss, 1);
        assert!(!limiter.stream_allowed(KEYED));
    }

    #[test]
    fn budgets_reset_in_the_next_period() {
        let limiter = enforcing(3, 3);
        for _ in 0..4 {
            limiter.charge_at(ANON, Budget::Miss, in_period(period()));
        }
        assert!(!limiter.stream_allowed_at(ANON, in_period(period() + 1) - 1));
        assert!(limiter.stream_allowed_at(ANON, in_period(period() + 1)));
    }

    #[test]
    fn pressure_divides_the_anonymous_budget() {
        let limiter = enforcing(9, 9);
        charge(&limiter, ANON, Budget::Miss, 4);
        assert!(limiter.stream_allowed(ANON));
        limiter.update_pressure(now_ms(), Some(true));
        assert!(!limiter.stream_allowed(ANON));
    }

    #[test]
    fn pressure_leaves_the_keyed_budget_alone() {
        let limiter = enforcing(9, 9);
        charge(&limiter, KEYED, Budget::Miss, 20);
        limiter.update_pressure(now_ms(), Some(true));
        assert!(limiter.stream_allowed(KEYED));
    }

    #[test]
    fn pressure_is_exposed_as_a_gauge() {
        let limiter = limiter(None);
        limiter.update_pressure(now_ms(), Some(true));
        assert!(limiter.inner.metrics.render().contains("stream_pressure_mode{app=\"torrentio-addon\"} 1"));
        limiter.update_pressure(now_ms() + 1, Some(false));
        assert!(limiter.inner.metrics.render().contains("stream_pressure_mode{app=\"torrentio-addon\"} 0"));
    }

    #[test]
    fn budgets_read_their_defaults() {
        let budgets = Budgets::default();
        assert!(!budgets.enforce);
        assert_eq!(budgets.limit(Budget::Miss, ANON, false), 100);
        assert_eq!(budgets.limit(Budget::Empty, ANON, true), 10);
        assert_eq!(budgets.limit(Budget::Empty, KEYED, true), 90);
        assert!((budgets.pressure_miss_rate - 100.0).abs() < f64::EPSILON);
    }

    #[tokio::test]
    async fn stopping_the_sync_task_waits_for_it_to_finish() {
        let limiter = limiter(None);
        let task = limiter.spawn_sync();
        timeout(Duration::from_secs(1), task.stop()).await.expect("stopped");
    }

    #[tokio::test]
    async fn failed_flush_keeps_counts_and_records_the_error() {
        let limiter = limiter(UNREACHABLE);
        limiter.allow("1.1.1.1");
        limiter.allow("1.1.1.1");
        limiter.flush().await;
        let mut state = limiter.inner.requests.state.lock();
        assert_eq!(state.window.take().items, vec![("1.1.1.1".to_owned(), 2)]);
    }
}
