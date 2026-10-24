use std::future::Future;

use tokio::sync::Semaphore;

use super::error::CatalogError;
use crate::infrastructure::metrics::Metrics;

pub struct Limiter {
    admission: Semaphore,
    permits: Semaphore,
    metrics: Metrics,
}

impl Limiter {
    pub fn new(max_concurrent: usize, queue_size: usize, metrics: Metrics) -> Self {
        Self {
            admission: Semaphore::new(max_concurrent + queue_size),
            permits: Semaphore::new(max_concurrent),
            metrics,
        }
    }

    pub async fn run<T>(&self, job: impl Future<Output = Result<T, CatalogError>>) -> Result<T, CatalogError> {
        let Ok(_admitted) = self.admission.try_acquire() else {
            self.metrics.limiter_dropped();
            return Err(CatalogError::Dropped);
        };
        let _permit = if let Ok(permit) = self.permits.try_acquire() {
            permit
        } else {
            let _queued = self.metrics.limiter_job("queued");
            self.permits.acquire().await.map_err(|_| CatalogError::Dropped)?
        };
        let _running = self.metrics.limiter_job("running");
        job.await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::sync::Notify;

    use super::*;

    #[tokio::test]
    async fn runs_jobs_within_the_limit() {
        let limiter = Limiter::new(2, 1, Metrics::new());
        assert_eq!(limiter.run(async { Ok(7) }).await.unwrap(), 7);
    }

    #[tokio::test]
    async fn cancelled_queued_jobs_free_their_queue_slot() {
        let limiter = Arc::new(Limiter::new(1, 1, Metrics::new()));
        let release = Arc::new(Notify::new());
        let running = tokio::spawn({
            let (limiter, release) = (Arc::clone(&limiter), Arc::clone(&release));
            async move {
                limiter
                    .run(async {
                        release.notified().await;
                        Ok(())
                    })
                    .await
            }
        });
        tokio::task::yield_now().await;
        for _ in 0..5 {
            let queued = tokio::spawn({
                let limiter = Arc::clone(&limiter);
                async move { limiter.run(async { Ok(()) }).await }
            });
            tokio::task::yield_now().await;
            queued.abort();
            let _ = queued.await;
        }
        let accepted = tokio::spawn({
            let limiter = Arc::clone(&limiter);
            async move { limiter.run(async { Ok(()) }).await }
        });
        tokio::task::yield_now().await;
        release.notify_one();
        assert!(running.await.unwrap().is_ok());
        assert!(accepted.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn drops_jobs_when_the_queue_is_full() {
        let metrics = Metrics::new();
        let limiter = Arc::new(Limiter::new(1, 1, metrics.clone()));
        let release = Arc::new(Notify::new());
        let running = tokio::spawn({
            let (limiter, release) = (Arc::clone(&limiter), Arc::clone(&release));
            async move {
                limiter
                    .run(async {
                        release.notified().await;
                        Ok(())
                    })
                    .await
            }
        });
        tokio::task::yield_now().await;
        let queued = tokio::spawn({
            let limiter = Arc::clone(&limiter);
            async move { limiter.run(async { Ok(()) }).await }
        });
        tokio::task::yield_now().await;
        let dropped = limiter.run(async { Ok(()) }).await;
        assert!(matches!(dropped, Err(CatalogError::Dropped)));
        let text = metrics.render();
        assert!(text.contains(r#"limiter_dropped_total{app="torrentio-catalogs"} 1"#));
        assert!(text.contains(r#"limiter_jobs{state="running",app="torrentio-catalogs"} 1"#));
        assert!(text.contains(r#"limiter_jobs{state="queued",app="torrentio-catalogs"} 1"#));
        release.notify_one();
        assert!(running.await.unwrap().is_ok());
        assert!(queued.await.unwrap().is_ok());
    }
}
