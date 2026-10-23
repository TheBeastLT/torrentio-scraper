use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use failsafe::{Config, Error as FailsafeError, StateMachine, backoff, failure_policy, futures::CircuitBreaker as _};

use crate::infrastructure::metrics::Metrics;

const REQUIRED_SUCCESS_RATE: f64 = 0.25;
const VOLUME_THRESHOLD: u32 = 10;
const ROLLING_WINDOW: Duration = Duration::from_secs(30);
const RESET_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub enum Fired<E> {
    Open,
    Failed(E),
}

struct Instrumented {
    name: String,
    closed: Arc<AtomicBool>,
    metrics: Metrics,
}

impl failsafe::Instrument for Instrumented {
    fn on_call_rejected(&self) {
        self.metrics.breaker_event(&self.name, "reject");
    }

    fn on_open(&self) {
        self.closed.store(false, Ordering::Relaxed);
        self.metrics.breaker_event(&self.name, "open");
    }

    fn on_half_open(&self) {
        self.closed.store(false, Ordering::Relaxed);
        self.metrics.breaker_event(&self.name, "halfOpen");
    }

    fn on_closed(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.metrics.breaker_event(&self.name, "close");
    }
}

type Machine = StateMachine<failure_policy::SuccessRateOverTimeWindow<backoff::Constant>, Instrumented>;

pub struct Breaker {
    machine: Machine,
    closed: Arc<AtomicBool>,
}

impl Breaker {
    pub fn new(name: impl Into<String>, metrics: Metrics) -> Self {
        let closed = Arc::new(AtomicBool::new(true));
        let policy = failure_policy::success_rate_over_time_window(
            REQUIRED_SUCCESS_RATE,
            VOLUME_THRESHOLD,
            ROLLING_WINDOW,
            backoff::constant(RESET_TIMEOUT),
        );
        let machine = Config::new()
            .failure_policy(policy)
            .instrument(Instrumented { name: name.into(), closed: Arc::clone(&closed), metrics })
            .build();
        Self { machine, closed }
    }

    pub fn is_open(&self) -> bool {
        !self.machine.is_call_permitted()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    pub async fn fire<T, E, Fut>(&self, action: Fut, counts_as_failure: impl Fn(&E) -> bool) -> Result<T, Fired<E>>
    where
        Fut: Future<Output = Result<T, E>>,
    {
        self.machine.call_with(move |error: &E| counts_as_failure(error), action).await.map_err(|error| match error {
            FailsafeError::Rejected => Fired::Open,
            FailsafeError::Inner(error) => Fired::Failed(error),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn passes_successful_results_through() {
        let breaker = Breaker::new("test", Metrics::new());
        assert_eq!(breaker.fire(async { Ok::<_, &str>(7) }, |_| true).await.unwrap(), 7);
        assert!(breaker.is_closed());
        assert!(!breaker.is_open());
    }

    #[tokio::test]
    async fn surfaces_inner_errors() {
        let breaker = Breaker::new("test", Metrics::new());
        let result = breaker.fire(async { Err::<(), _>("boom") }, |_| true).await;
        assert!(matches!(result, Err(Fired::Failed("boom"))));
    }

    #[tokio::test]
    async fn filtered_errors_never_trip_the_breaker() {
        let breaker = Breaker::new("test", Metrics::new());
        for _ in 0..50 {
            let _ = breaker.fire(async { Err::<(), _>("user") }, |_| false).await;
        }
        assert!(breaker.is_closed());
        assert!(!breaker.is_open());
    }
}
