use std::time::Duration;

use async_trait::async_trait;
use mongodb::{
    Client, Collection, IndexModel,
    bson::{self, Bson, DateTime, Document, doc},
    options::{ClientOptions, Compressor, IndexOptions},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::domain::{CacheStore, SourceError};

pub const CATALOG_COLLECTION: &str = "torrentio_catalog_collection";
const OPERATION_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
struct Stored {
    value: Bson,
}

#[derive(Serialize)]
struct Entry<'a> {
    key: &'a str,
    value: Bson,
    #[serde(rename = "expiresAt")]
    expires_at: DateTime,
}

pub async fn connect(uri: &str) -> Result<Client, mongodb::error::Error> {
    let mut options = ClientOptions::parse(uri).await?;
    options.compressors = Some(vec![Compressor::Zstd { level: None }]);
    Client::with_options(options)
}

#[derive(Clone)]
pub struct Store {
    collection: Collection<Document>,
}

impl Store {
    pub fn new(client: &Client, name: &str) -> Self {
        let database = client.default_database().unwrap_or_else(|| client.database("test"));
        Self { collection: database.collection(name) }
    }

    pub async fn ensure_indexes(&self) {
        let unique =
            IndexModel::builder().keys(doc! { "key": 1 }).options(IndexOptions::builder().unique(true).build()).build();
        let expiry = IndexModel::builder()
            .keys(doc! { "expiresAt": 1 })
            .options(IndexOptions::builder().expire_after(Duration::ZERO).build())
            .build();
        if let Err(error) = self.collection.create_indexes([unique, expiry]).await {
            tracing::warn!(collection = self.collection.name(), %error, "Failed creating indexes");
        }
    }
}

fn failure(error: &impl ToString) -> SourceError {
    SourceError(error.to_string())
}

async fn bounded<T>(operation: impl Future<Output = Result<T, SourceError>>) -> Result<T, SourceError> {
    tokio::time::timeout(OPERATION_TIMEOUT, operation).await.map_err(|_| failure(&"cache operation timed out"))?
}

fn to_bson(value: &Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(flag) => Bson::Boolean(*flag),
        Value::Number(number) => number_to_bson(number),
        Value::String(text) => Bson::String(text.clone()),
        Value::Array(items) => Bson::Array(items.iter().map(to_bson).collect()),
        Value::Object(entries) => {
            Bson::Document(entries.iter().map(|(key, item)| (key.clone(), to_bson(item))).collect())
        }
    }
}

fn number_to_bson(number: &serde_json::Number) -> Bson {
    let float = number.as_f64().unwrap_or_default();
    match i32::try_from(number.as_i64().unwrap_or(i64::MAX)) {
        Ok(int) => Bson::Int32(int),
        Err(_) if float.fract() == 0.0 && float.abs() <= f64::from(i32::MAX) => Bson::Int32(float as i32),
        Err(_) => Bson::Double(float),
    }
}

#[async_trait]
impl CacheStore for Store {
    async fn get(&self, key: &str) -> Result<Option<Value>, SourceError> {
        let stored = bounded(async {
            self.collection
                .clone_with_type::<Stored>()
                .find_one(doc! { "key": { "$eq": key } })
                .projection(doc! { "_id": 0, "value": 1 })
                .await
                .map_err(|error| failure(&error))
        })
        .await?;
        stored.map(|stored| bson::from_bson(stored.value).map_err(|error| failure(&error))).transpose()
    }

    async fn set(&self, key: &str, value: &Value, ttl: Duration) -> Result<(), SourceError> {
        let expires_at = DateTime::from_millis(DateTime::now().timestamp_millis() + ttl.as_millis() as i64);
        let entry = Entry { key, value: to_bson(value), expires_at };
        let update = doc! { "$set": bson::to_document(&entry).map_err(|error| failure(&error))? };
        bounded(async {
            self.collection
                .update_one(doc! { "key": { "$eq": key } }, update)
                .upsert(true)
                .await
                .map(|_| ())
                .map_err(|error| failure(&error))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn numbers_are_stored_like_the_node_driver_does() {
        let bson =
            to_bson(&json!({ "small": 100, "negative": -5, "whole": 2.0, "half": 1.5, "big": 5_000_000_000_i64 }));
        let document = bson.as_document().unwrap();
        assert_eq!(document.get("small"), Some(&Bson::Int32(100)));
        assert_eq!(document.get("negative"), Some(&Bson::Int32(-5)));
        assert_eq!(document.get("whole"), Some(&Bson::Int32(2)));
        assert_eq!(document.get("half"), Some(&Bson::Double(1.5)));
        assert_eq!(document.get("big"), Some(&Bson::Double(5e9)));
    }

    #[test]
    fn nested_values_keep_their_order_and_types() {
        let value = json!({ "z": [1, "a", null, true], "a": { "k": "v" } });
        let bson = to_bson(&value);
        let keys: Vec<&String> = bson.as_document().unwrap().keys().collect();
        assert_eq!(keys, ["z", "a"]);
        assert_eq!(bson::from_bson::<Value>(bson).unwrap(), value);
    }
}
