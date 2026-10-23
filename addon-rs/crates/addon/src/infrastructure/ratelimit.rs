use std::{sync::Arc, time::Duration};

use redis::{
    Client, RedisError, Script,
    aio::{ConnectionManager, ConnectionManagerConfig},
};
use tokio::{sync::OnceCell, time::timeout};

use crate::infrastructure::metrics::Metrics;

const WINDOW: Duration = Duration::from_secs(24 * 60 * 60);
const LIMIT: i64 = 5000;
const KEY_PREFIX: &str = "rl:";
const CONNECTION_TIMEOUT: Duration = Duration::from_millis(500);
const OPERATION_TIMEOUT: Duration = Duration::from_millis(250);

const INCREMENT: &str = r#"
local totalHits = redis.call("INCR", KEYS[1])
local timeToExpire = redis.call("PTTL", KEYS[1])
if timeToExpire <= 0 or ARGV[1] == "1" then
  redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[2]))
  timeToExpire = tonumber(ARGV[2])
end
return { totalHits, timeToExpire }
"#;

#[derive(Debug, thiserror::Error)]
enum LimiterError {
    #[error(transparent)]
    Redis(#[from] RedisError),
    #[error("timed out")]
    TimedOut,
}

#[derive(Clone)]
pub struct RateLimiter {
    client: Option<Client>,
    connection: Arc<OnceCell<ConnectionManager>>,
    script: Arc<Script>,
    metrics: Metrics,
}

impl RateLimiter {
    pub fn new(url: Option<&str>, metrics: Metrics) -> Self {
        let client = url
            .and_then(|url| Client::open(url).inspect_err(|error| tracing::error!(%error, "Redis client error")).ok());
        Self { client, connection: Arc::default(), script: Arc::new(Script::new(INCREMENT)), metrics }
    }

    pub async fn allow(&self, client: &str) -> bool {
        let Some(redis) = &self.client else {
            return true;
        };
        let result = timeout(OPERATION_TIMEOUT, self.hits(redis, client)).await.unwrap_or(Err(LimiterError::TimedOut));
        match result {
            Ok(hits) => hits <= LIMIT,
            Err(error) => {
                self.metrics.rate_limiter_store_error();
                tracing::warn!(%error, "Redis client error");
                true
            }
        }
    }

    async fn hits(&self, redis: &Client, client: &str) -> Result<i64, LimiterError> {
        let mut connection = self
            .connection
            .get_or_try_init(|| {
                let config = ConnectionManagerConfig::new().set_connection_timeout(CONNECTION_TIMEOUT);
                ConnectionManager::new_with_config(redis.clone(), config)
            })
            .await?
            .clone();
        let (hits, _expires_in): (i64, i64) = self
            .script
            .key(format!("{KEY_PREFIX}{client}"))
            .arg(0)
            .arg(WINDOW.as_millis() as u64)
            .invoke_async(&mut connection)
            .await?;
        Ok(hits)
    }
}
