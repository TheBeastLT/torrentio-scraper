use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use prometheus::{
    Counter, CounterVec, Encoder, Gauge, GaugeVec, Histogram, HistogramOpts, HistogramVec, IntGauge, Opts, Registry,
    TextEncoder,
};

const HTTP_BUCKETS: &[f64] = &[0.05, 0.1, 0.5, 1.0, 2.5, 10.0, 30.0];
const LAG_BUCKETS: &[f64] = &[0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0];
const LAG_SAMPLE_INTERVAL: Duration = Duration::from_millis(100);
const METADATA_BUCKETS: &[f64] = &[0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 15.0];
const DB_BUCKETS: &[f64] = &[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0];

#[derive(Clone)]
pub struct Metrics {
    registry: Registry,
    http_duration: HistogramVec,
    http_requests: CounterVec,
    http_responses: CounterVec,
    metadata_requests: CounterVec,
    db_duration: HistogramVec,
    cache_duration: HistogramVec,
    cache_requests: CounterVec,
    db_pool_connections: GaugeVec,
    catalog_requests: CounterVec,
    metadata_duration: HistogramVec,
    limiter_dropped: Counter,
    limiter_jobs: GaugeVec,
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

pub struct StateGuard(Gauge);

impl Drop for StateGuard {
    fn drop(&mut self) {
        self.0.dec();
    }
}

pub struct Timer {
    histogram: prometheus::Histogram,
    started: Instant,
}

impl Timer {
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
        let registry = Registry::new_custom(None, Some([("app".to_owned(), "torrentio-catalogs".to_owned())].into()))
            .expect("valid registry");
        #[cfg(target_os = "linux")]
        registry
            .register(Box::new(prometheus::process_collector::ProcessCollector::for_self()))
            .expect("process collector");
        let db_pool_connections =
            GaugeVec::new(Opts::new("db_pool_connections", "Postgres connection pool state"), &["state"])
                .expect("valid gauge");
        registry.register(Box::new(db_pool_connections.clone())).expect("unique metric");
        let limiter_dropped = Counter::new(
            "limiter_dropped_total",
            "Catalog requests dropped because the concurrency limiter queue was full",
        )
        .expect("valid counter");
        registry.register(Box::new(limiter_dropped.clone())).expect("unique metric");
        let limiter_jobs = GaugeVec::new(
            Opts::new("limiter_jobs", "Catalog jobs in the concurrency limiter by state (running, queued)"),
            &["state"],
        )
        .expect("valid gauge");
        registry.register(Box::new(limiter_jobs.clone())).expect("unique metric");
        Self {
            runtime: RuntimeMetrics::new(&registry),
            catalog_requests: counter(
                &registry,
                "catalog_requests_total",
                "Catalog requests by catalog and outcome",
                &["catalog", "outcome"],
            ),
            metadata_duration: histogram(
                &registry,
                "metadata_request_duration_seconds",
                "Cinemeta/Kitsu metadata request duration by source",
                &["source"],
                METADATA_BUCKETS,
            ),
            limiter_dropped,
            limiter_jobs,
            http_duration: histogram(
                &registry,
                "http_request_duration_seconds",
                "HTTP request duration",
                &["resource"],
                HTTP_BUCKETS,
            ),
            http_requests: counter(&registry, "http_requests_total", "HTTP requests by resource", &["resource"]),
            http_responses: counter(
                &registry,
                "http_responses_total",
                "HTTP responses by resource and status",
                &["resource", "status"],
            ),
            metadata_requests: counter(
                &registry,
                "metadata_requests_total",
                "Cinemeta/Kitsu metadata requests by source and outcome",
                &["source", "outcome"],
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
            cache_requests: counter(&registry, "cache_requests_total", "Cache lookups by result", &["cache", "result"]),
            db_pool_connections,
            registry,
        }
    }

    pub fn http_request(&self, resource: &str, status: u16, elapsed: Duration) {
        self.http_duration.with_label_values(&[resource]).observe(elapsed.as_secs_f64());
        self.http_requests.with_label_values(&[resource]).inc();
        self.http_responses.with_label_values(&[resource, &status.to_string()]).inc();
    }

    pub fn observe_db(&self, operation: &str, elapsed: Duration) {
        self.db_duration.with_label_values(&[operation]).observe(elapsed.as_secs_f64());
    }

    pub fn cache_timer(&self, operation: &str) -> Timer {
        Timer { histogram: self.cache_duration.with_label_values(&[operation]), started: Instant::now() }
    }

    pub fn cache_result(&self, cache: &str, result: &str) {
        self.cache_requests.with_label_values(&[cache, result]).inc();
    }

    pub fn catalog_request(&self, catalog: &str, outcome: &str) {
        self.catalog_requests.with_label_values(&[catalog, outcome]).inc();
    }

    pub fn metadata_request(&self, source: &str, outcome: &str, elapsed: Duration) {
        self.metadata_duration.with_label_values(&[source]).observe(elapsed.as_secs_f64());
        self.metadata_requests.with_label_values(&[source, outcome]).inc();
    }

    pub fn limiter_dropped(&self) {
        self.limiter_dropped.inc();
    }

    pub fn limiter_job(&self, state: &str) -> StateGuard {
        let gauge = self.limiter_jobs.with_label_values(&[state]);
        gauge.inc();
        StateGuard(gauge)
    }

    pub fn observe_runtime(&self) {
        self.runtime.observe();
    }

    pub fn spawn_lag_sampler(&self) {
        self.runtime.spawn_lag_sampler();
    }

    pub fn pool(&self, size: u32, idle: u32) {
        self.db_pool_connections.with_label_values(&["size"]).set(f64::from(size));
        self.db_pool_connections.with_label_values(&["available"]).set(f64::from(idle));
        self.db_pool_connections.with_label_values(&["using"]).set(f64::from(size.saturating_sub(idle)));
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

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &str = r#"app="torrentio-catalogs""#;

    fn series(text: &str, name: &str, labels: &str) -> bool {
        text.lines().any(|line| line.starts_with(name) && line.contains(labels) && line.contains(APP))
    }

    #[test]
    fn renders_http_db_and_cache_series_with_the_app_label() {
        let metrics = Metrics::new();
        metrics.http_request("catalog", 200, Duration::from_millis(5));
        metrics.observe_db("SELECT", Duration::from_millis(5));
        metrics.cache_timer("get").finish();
        metrics.cache_result("catalog", "hit");
        metrics.pool(5, 2);
        let text = metrics.render();
        assert!(text.contains(r#"http_requests_total{resource="catalog",app="torrentio-catalogs"} 1"#));
        assert!(series(&text, "http_request_duration_seconds_count", r#"resource="catalog""#));
        assert!(!text.contains(r#"http_request_duration_seconds_count{resource="catalog",status"#));
        assert!(text.contains(r#"http_responses_total{resource="catalog",status="200",app="torrentio-catalogs"} 1"#));
        assert!(series(&text, "db_operation_duration_seconds_count", r#"operation="SELECT""#));
        assert!(series(&text, "cache_operation_duration_seconds_count", r#"operation="get""#));
        assert!(text.contains(r#"cache_requests_total{cache="catalog",result="hit",app="torrentio-catalogs"} 1"#));
        assert!(text.contains(r#"db_pool_connections{state="using",app="torrentio-catalogs"} 3"#));
    }

    #[test]
    fn renders_catalog_and_metadata_series() {
        let metrics = Metrics::new();
        metrics.catalog_request("top-movies", "ok");
        metrics.metadata_request("cinemeta", "timeout", Duration::from_secs(10));
        let text = metrics.render();
        assert!(series(&text, "catalog_requests_total", r#"catalog="top-movies",outcome="ok""#));
        assert!(series(&text, "metadata_request_duration_seconds_count", r#"source="cinemeta""#));
        assert!(!text.contains("metadata_request_duration_seconds_count{outcome"));
        assert!(series(&text, "metadata_requests_total", r#"outcome="timeout",source="cinemeta""#));
    }

    #[test]
    fn limiter_gauges_follow_their_guards() {
        let metrics = Metrics::new();
        metrics.limiter_dropped();
        let running = metrics.limiter_job("running");
        let queued = metrics.limiter_job("queued");
        let text = metrics.render();
        assert!(text.contains(r#"limiter_dropped_total{app="torrentio-catalogs"} 1"#));
        assert!(text.contains(r#"limiter_jobs{state="running",app="torrentio-catalogs"} 1"#));
        drop((running, queued));
        assert!(metrics.render().contains(r#"limiter_jobs{state="queued",app="torrentio-catalogs"} 0"#));
    }

    #[tokio::test]
    async fn renders_runtime_series() {
        let metrics = Metrics::new();
        metrics.spawn_lag_sampler();
        tokio::time::sleep(Duration::from_millis(250)).await;
        metrics.observe_runtime();
        let text = metrics.render();
        for name in ["runtime_utilization", "runtime_alive_tasks", "runtime_global_queue_depth"] {
            assert!(series(&text, name, ""), "{name}");
        }
        assert!(series(&text, "runtime_scheduling_lag_seconds_count", ""));
        assert!(!text.contains("runtime_scheduling_lag_seconds_count{app=\"torrentio-catalogs\"} 0"));
    }
}
