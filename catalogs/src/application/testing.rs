use std::{collections::HashMap, sync::Arc, sync::Mutex, time::Duration};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::{Catalogs, Settings};
use crate::{
    domain::{CacheStore, ContentType, IdQuery, IdRepository, MetadataSource, SourceError},
    infrastructure::metrics::Metrics,
};

#[derive(Default)]
pub struct FakeIds {
    pub ids: Vec<String>,
    pub calls: Mutex<Vec<IdQuery>>,
    pub fail: bool,
}

impl FakeIds {
    pub fn with_count(count: usize) -> Self {
        Self { ids: (1..=count).map(|n| format!("tt{n}")).collect(), ..Self::default() }
    }
}

#[async_trait]
impl IdRepository for FakeIds {
    async fn top_ids(&self, query: &IdQuery) -> Result<Vec<String>, SourceError> {
        self.calls.lock().unwrap().push(query.clone());
        if self.fail {
            return Err(SourceError("database down".to_owned()));
        }
        Ok(self.ids.clone())
    }

    fn pool_stats(&self) -> (u32, u32) {
        (0, 0)
    }
}

#[derive(Default)]
pub struct FakeMetadata {
    pub calls: Mutex<Vec<(Vec<String>, ContentType)>>,
}

#[async_trait]
impl MetadataSource for FakeMetadata {
    async fn metas(&self, ids: &[String], kind: ContentType) -> Result<Vec<Value>, SourceError> {
        self.calls.lock().unwrap().push((ids.to_vec(), kind));
        Ok(ids.iter().take(40).map(|id| json!({ "id": id, "name": format!("Title {id}") })).collect())
    }
}

#[derive(Default)]
pub struct FakeStore {
    pub entries: Mutex<HashMap<String, Value>>,
}

#[async_trait]
impl CacheStore for FakeStore {
    async fn get(&self, key: &str) -> Result<Option<Value>, SourceError> {
        Ok(self.entries.lock().unwrap().get(key).cloned())
    }

    async fn set(&self, key: &str, value: &Value, _ttl: Duration) -> Result<(), SourceError> {
        self.entries.lock().unwrap().insert(key.to_owned(), value.clone());
        Ok(())
    }
}

pub fn fixture_catalogs(ids: Arc<FakeIds>, metrics: Metrics) -> Catalogs {
    Catalogs::new(ids, Arc::new(FakeMetadata::default()), None, metrics, Settings::default())
}
