use std::{future::Future, sync::Arc};

use singleflight_async::SingleFlight;
use tokio::sync::Semaphore;

pub struct NamedQueue<T> {
    flight: SingleFlight<String, T>,
    permits: Arc<Semaphore>,
}

impl<T: Clone> NamedQueue<T> {
    pub fn new(concurrency: usize) -> Self {
        Self { flight: SingleFlight::new(), permits: Arc::new(Semaphore::new(concurrency)) }
    }

    pub async fn wrap<F, Fut>(&self, id: impl Into<String>, method: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let permits = Arc::clone(&self.permits);
        self.flight
            .work(id.into(), move || async move {
                let _permit = permits.acquire_owned().await.ok();
                method().await
            })
            .await
    }
}

pub struct Limiter(Semaphore);

impl Limiter {
    pub fn new(concurrency: usize) -> Self {
        Self(Semaphore::new(concurrency))
    }

    pub async fn run<Fut: Future>(&self, work: Fut) -> Fut::Output {
        let _permit = self.0.acquire().await.ok();
        work.await
    }
}
