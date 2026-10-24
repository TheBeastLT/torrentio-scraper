use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use super::catalog::{ContentType, DateRange};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SourceError(pub String);

#[derive(Debug, Clone)]
pub struct IdQuery {
    pub kind: ContentType,
    pub providers: Vec<String>,
    pub range: Option<DateRange>,
}

#[async_trait]
pub trait IdRepository: Send + Sync {
    async fn top_ids(&self, query: &IdQuery) -> Result<Vec<String>, SourceError>;

    fn pool_stats(&self) -> (u32, u32);
}

#[async_trait]
pub trait MetadataSource: Send + Sync {
    async fn metas(&self, ids: &[String], kind: ContentType) -> Result<Vec<Value>, SourceError>;
}

#[async_trait]
pub trait CacheStore: Send + Sync {
    async fn get(&self, key: &str) -> Result<Option<Value>, SourceError>;

    async fn set(&self, key: &str, value: &Value, ttl: Duration) -> Result<(), SourceError>;
}
