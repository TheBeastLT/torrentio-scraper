use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use prometheus::{
    CounterVec, Encoder, Gauge, GaugeVec, Histogram, HistogramOpts, HistogramVec, IntGauge, Opts, Registry, TextEncoder,
};

const HTTP_BUCKETS: &[f64] = &[0.05, 0.1, 0.5, 1.0, 2.5, 10.0, 30.0];
const DB_BUCKETS: &[f64] = &[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0];
const RESOLVE_BUCKETS: &[f64] = &[0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0];
const LAG_BUCKETS: &[f64] = &[0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0];
const LAG_SAMPLE_INTERVAL: Duration = Duration::from_millis(100);
const AVAILABILITY_BUCKETS: &[f64] = &[0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 15.0, 20.0, 30.0];

#[derive(Clone)]
pub struct Metrics {
    registry: Registry,
    http_duration: HistogramVec,
    http_requests: CounterVec,
    db_duration: HistogramVec,
    cache_duration: HistogramVec,
    cache_requests: CounterVec,
    moch_resolve: HistogramVec,
    moch_availability: HistogramVec,
    token_blacklist_events: CounterVec,
    token_blacklist_size: Gauge,
    rate_limiter_store_errors: prometheus::Counter,
    breaker_events: CounterVec,
    db_pool_connections: GaugeVec,
    memory_cache_bytes: GaugeVec,
    memory_cache_entries: GaugeVec,
    runtime: RuntimeMetrics,
}

#[derive(Clone)]
struct RuntimeMetrics {
    scheduling_lag: Histogram,
    utilization: Gauge,
    alive_tasks: IntGauge,
    global_queue_depth: IntGauge,
    sample: Arc<Mutex<(Instant, Duration)>>,
}

impl RuntimeMetrics {
    fn new(registry: &Registry) -> Self {
        let scheduling_lag = Histogram::with_opts(
            HistogramOpts::new("runtime_scheduling_lag_seconds", "Delay of a 100ms timer on the async runtime")
                .buckets(LAG_BUCKETS.to_vec()),
        )
        .expect("valid histogram");
        registry.register(Box::new(scheduling_lag.clone())).expect("unique metric");
        Self {
            scheduling_lag,
            utilization: gauge(
                registry,
                "runtime_utilization",
                "Share of worker time spent busy since the previous scrape (0-1)",
            ),
            alive_tasks: int_gauge(registry, "runtime_alive_tasks", "Tasks currently alive on the async runtime"),
            global_queue_depth: int_gauge(
                registry,
                "runtime_global_queue_depth",
                "Tasks waiting in the runtime global queue",
            ),
            sample: Arc::new(Mutex::new((Instant::now(), Duration::ZERO))),
        }
    }

    fn observe(&self) {
        let runtime = tokio::runtime::Handle::current().metrics();
        let workers = runtime.num_workers();
        let busy: Duration = (0..workers).map(|worker| runtime.worker_total_busy_duration(worker)).sum();
        let mut sample = self.sample.lock();
        let (previous_at, previous_busy) = *sample;
        let capacity = previous_at.elapsed().as_secs_f64() * workers as f64;
        if capacity > 0.0 {
            self.utilization.set((busy.saturating_sub(previous_busy).as_secs_f64() / capacity).min(1.0));
        }
        *sample = (Instant::now(), busy);
        self.alive_tasks.set(runtime.num_alive_tasks() as i64);
        self.global_queue_depth.set(runtime.global_queue_depth() as i64);
    }

    fn spawn_lag_sampler(&self) {
        let histogram = self.scheduling_lag.clone();
        tokio::spawn(async move {
            loop {
                let started = Instant::now();
                tokio::time::sleep(LAG_SAMPLE_INTERVAL).await;
                histogram.observe(started.elapsed().saturating_sub(LAG_SAMPLE_INTERVAL).as_secs_f64());
            }
        });
    }
}

pub struct WaitingGuard(Gauge);

impl Drop for WaitingGuard {
    fn drop(&mut self) {
        self.0.dec();
    }
}

pub struct Timer {
    histogram: HistogramVec,
    labels: Vec<String>,
    started: Instant,
}

impl Timer {
    pub fn finish(self, outcome: &str) {
        let mut labels: Vec<&str> = self.labels.iter().map(String::as_str).collect();
        labels.push(outcome);
        self.histogram.with_label_values(&labels).observe(self.started.elapsed().as_secs_f64());
    }
}

pub struct SimpleTimer {
    histogram: prometheus::Histogram,
    started: Instant,
}

impl SimpleTimer {
    pub fn finish(self) {
        self.histogram.observe(self.started.elapsed().as_secs_f64());
    }
}

fn histogram(registry: &Registry, name: &str, help: &str, labels: &[&str], buckets: &[f64]) -> HistogramVec {
    let metric =
        HistogramVec::new(HistogramOpts::new(name, help).buckets(buckets.to_vec()), labels).expect("valid histogram");
    registry.register(Box::new(metric.clone())).expect("unique metric");
    metric
}

fn gauge(registry: &Registry, name: &str, help: &str) -> Gauge {
    let metric = Gauge::new(name, help).expect("valid gauge");
    registry.register(Box::new(metric.clone())).expect("unique metric");
    metric
}

fn int_gauge(registry: &Registry, name: &str, help: &str) -> IntGauge {
    let metric = IntGauge::new(name, help).expect("valid gauge");
    registry.register(Box::new(metric.clone())).expect("unique metric");
    metric
}

fn counter(registry: &Registry, name: &str, help: &str, labels: &[&str]) -> CounterVec {
    let metric = CounterVec::new(Opts::new(name, help), labels).expect("valid counter");
    registry.register(Box::new(metric.clone())).expect("unique metric");
    metric
}

impl Metrics {
    pub fn new() -> Self {
        let registry = Registry::new_custom(None, Some([("app".to_owned(), "torrentio-addon".to_owned())].into()))
            .expect("valid registry");
        #[cfg(target_os = "linux")]
        registry
            .register(Box::new(prometheus::process_collector::ProcessCollector::for_self()))
            .expect("process collector");
        let rate_limiter_store_errors = prometheus::Counter::new(
            "rate_limiter_store_errors_total",
            "Rate limiter Redis store errors (requests pass un-limited while these occur)",
        )
        .expect("valid counter");
        registry.register(Box::new(rate_limiter_store_errors.clone())).expect("unique metric");
        let db_pool_connections =
            GaugeVec::new(Opts::new("db_pool_connections", "Postgres connection pool state"), &["state"])
                .expect("valid gauge");
        registry.register(Box::new(db_pool_connections.clone())).expect("unique metric");
        let memory_cache_bytes =
            GaugeVec::new(Opts::new("memory_cache_bytes", "Weighted size of the in-memory caches"), &["cache"])
                .expect("valid gauge");
        registry.register(Box::new(memory_cache_bytes.clone())).expect("unique metric");
        let memory_cache_entries =
            GaugeVec::new(Opts::new("memory_cache_entries", "Entries in the in-memory caches"), &["cache"])
                .expect("valid gauge");
        registry.register(Box::new(memory_cache_entries.clone())).expect("unique metric");
        let token_blacklist_size =
            gauge(&registry, "moch_token_blacklist_size", "Size of the in-memory moch token blacklist");
        Self {
            runtime: RuntimeMetrics::new(&registry),
            http_duration: histogram(
                &registry,
                "http_request_duration_seconds",
                "HTTP request duration",
                &["resource", "status"],
                HTTP_BUCKETS,
            ),
            http_requests: counter(
                &registry,
                "http_requests_total",
                "HTTP requests by resource and debrid provider",
                &["resource", "moch"],
            ),
            db_duration: histogram(
                &registry,
                "db_operation_duration_seconds",
                "Postgres query duration",
                &["operation"],
                DB_BUCKETS,
            ),
            cache_duration: histogram(
                &registry,
                "cache_operation_duration_seconds",
                "Cache backing-store (Mongo) operation duration",
                &["operation"],
                DB_BUCKETS,
            ),
            cache_requests: counter(
                &registry,
                "cache_requests_total",
                "Cache lookups by serving tier",
                &["cache", "result"],
            ),
            moch_resolve: histogram(
                &registry,
                "moch_resolve_duration_seconds",
                "Debrid resolve duration by moch and outcome",
                &["moch", "outcome"],
                RESOLVE_BUCKETS,
            ),
            moch_availability: histogram(
                &registry,
                "moch_availability_duration_seconds",
                "Debrid availability check duration by moch and outcome",
                &["moch", "outcome"],
                AVAILABILITY_BUCKETS,
            ),
            token_blacklist_events: counter(
                &registry,
                "moch_token_blacklist_events_total",
                "Tokens added to the moch blacklist",
                &["moch"],
            ),
            breaker_events: counter(
                &registry,
                "moch_breaker_events_total",
                "Resolve circuit breaker events by moch and event",
                &["moch", "event"],
            ),
            token_blacklist_size,
            rate_limiter_store_errors,
            db_pool_connections,
            memory_cache_bytes,
            memory_cache_entries,
            registry,
        }
    }

    pub fn observe_db(&self, operation: &str, elapsed: Duration) {
        self.db_duration.with_label_values(&[operation]).observe(elapsed.as_secs_f64());
    }

    pub fn cache_timer(&self, operation: &str) -> SimpleTimer {
        SimpleTimer { histogram: self.cache_duration.with_label_values(&[operation]), started: Instant::now() }
    }

    pub fn cache_result(&self, cache: &str, result: &str) {
        self.cache_requests.with_label_values(&[cache, result]).inc();
    }

    pub fn resolve_timer(&self, moch: &str) -> Timer {
        Timer { histogram: self.moch_resolve.clone(), labels: vec![moch.to_owned()], started: Instant::now() }
    }

    pub fn availability_timer(&self, moch: &str) -> Timer {
        Timer { histogram: self.moch_availability.clone(), labels: vec![moch.to_owned()], started: Instant::now() }
    }

    pub fn token_blacklisted(&self, moch: &str, size: usize) {
        self.token_blacklist_events.with_label_values(&[moch]).inc();
        self.token_blacklist_size.set(size as f64);
    }

    pub fn rate_limiter_store_error(&self) {
        self.rate_limiter_store_errors.inc();
    }

    pub fn breaker_event(&self, moch: &str, event: &str) {
        self.breaker_events.with_label_values(&[moch, event]).inc();
    }

    pub fn http_request(&self, resource: &str, moch: &str, status: u16, elapsed: Duration) {
        self.http_duration.with_label_values(&[resource, &status.to_string()]).observe(elapsed.as_secs_f64());
        self.http_requests.with_label_values(&[resource, moch]).inc();
    }

    pub fn pool(&self, size: u32, idle: u32) {
        self.db_pool_connections.with_label_values(&["size"]).set(f64::from(size));
        self.db_pool_connections.with_label_values(&["available"]).set(f64::from(idle));
        self.db_pool_connections.with_label_values(&["using"]).set(f64::from(size.saturating_sub(idle)));
    }

    #[allow(clippy::cast_precision_loss)]
    pub fn memory_cache(&self, cache: &str, bytes: Option<u64>, entries: u64) {
        if let Some(bytes) = bytes {
            self.memory_cache_bytes.with_label_values(&[cache]).set(bytes as f64);
        }
        self.memory_cache_entries.with_label_values(&[cache]).set(entries as f64);
    }

    pub fn pool_waiting(&self) -> WaitingGuard {
        let gauge = self.db_pool_connections.with_label_values(&["waiting"]);
        gauge.inc();
        WaitingGuard(gauge)
    }

    pub fn observe_runtime(&self) {
        self.runtime.observe();
    }

    pub fn spawn_lag_sampler(&self) {
        self.runtime.spawn_lag_sampler();
    }

    pub fn render(&self) -> String {
        let mut buffer = Vec::new();
        TextEncoder::new().encode(&self.registry.gather(), &mut buffer).expect("metrics encode");
        String::from_utf8(buffer).unwrap_or_default()
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}
