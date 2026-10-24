use std::{collections::HashMap, sync::Arc, time::Duration};

use futures::TryStreamExt;
use mongodb::{
    Client, Collection, IndexModel,
    bson::{self, Binary, Bson, DateTime, Document, doc, spec::BinarySubtype},
    options::{ClientOptions, Compressor, IndexOptions},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

const MIN_POOL_SIZE: u32 = 50;
const MAX_POOL_SIZE: u32 = 200;
const MAX_CONNECTING: u32 = 5;
const ZSTD_LEVEL: i32 = 0;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Mongo(#[from] mongodb::error::Error),
    #[error(transparent)]
    Bson(#[from] bson::ser::Error),
    #[error(transparent)]
    BsonDecode(#[from] bson::de::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("zstd: {0}")]
    Zstd(#[from] std::io::Error),
    #[error(transparent)]
    Join(#[from] tokio::task::JoinError),
}

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Deserialize)]
struct Stored {
    key: Option<String>,
    value: Bson,
}

#[derive(Serialize)]
struct Entry<'a> {
    key: &'a str,
    value: Bson,
    #[serde(rename = "expiresAt")]
    expires_at: DateTime,
}

#[derive(Clone)]
pub struct Packed(Arc<[u8]>);

impl Packed {
    pub async fn encode<T: Serialize + Send + Sync + 'static + ?Sized>(value: Arc<T>) -> Result<Self> {
        let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
            Ok(zstd::encode_all(serde_json::to_vec(value.as_ref())?.as_slice(), ZSTD_LEVEL)?)
        })
        .await??;
        Ok(Self(bytes.into()))
    }

    pub async fn decode<T: DeserializeOwned + Send + 'static>(&self) -> Result<T> {
        let bytes = Arc::clone(&self.0);
        tokio::task::spawn_blocking(move || -> Result<T> {
            Ok(serde_json::from_slice(&zstd::decode_all(bytes.as_ref())?)?)
        })
        .await?
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

pub async fn connect(uri: &str) -> Result<Client> {
    let mut options = ClientOptions::parse(uri).await?;
    options.compressors = Some(vec![Compressor::Zstd { level: None }]);
    options.min_pool_size = Some(MIN_POOL_SIZE);
    options.max_pool_size = Some(MAX_POOL_SIZE);
    options.max_connecting = Some(MAX_CONNECTING);
    Ok(Client::with_options(options)?)
}

#[derive(Clone)]
pub struct Store {
    collection: Collection<Document>,
    compress_values: bool,
}

impl Store {
    pub fn new(client: &Client, database: Option<&str>, name: &str, compress_values: bool) -> Self {
        let database = database
            .map(|name| client.database(name))
            .or_else(|| client.default_database())
            .unwrap_or_else(|| client.database("test"));
        Self { collection: database.collection(name), compress_values }
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

    pub async fn get<T: DeserializeOwned + Send + 'static>(&self, key: &str) -> Result<Option<T>> {
        let stored = self
            .collection
            .clone_with_type::<Stored>()
            .find_one(doc! { "key": { "$eq": key } })
            .projection(doc! { "_id": 0, "value": 1 })
            .await?;
        match stored {
            Some(stored) => Ok(Some(decode(stored.value).await?)),
            None => Ok(None),
        }
    }

    pub async fn get_many<T: DeserializeOwned + Send + 'static>(&self, keys: &[String]) -> Result<Vec<Option<T>>> {
        let stored: Vec<Stored> = self
            .collection
            .clone_with_type::<Stored>()
            .find(doc! { "key": { "$in": keys } })
            .projection(doc! { "_id": 0, "key": 1, "value": 1 })
            .await?
            .try_collect()
            .await?;
        let mut values: HashMap<String, T> = HashMap::with_capacity(stored.len());
        for entry in stored {
            if let Some(key) = entry.key {
                values.insert(key, decode(entry.value).await?);
            }
        }
        Ok(keys.iter().map(|key| values.remove(key)).collect())
    }

    pub async fn get_packed(&self, key: &str) -> Result<Option<Packed>> {
        let stored = self
            .collection
            .clone_with_type::<Stored>()
            .find_one(doc! { "key": { "$eq": key } })
            .projection(doc! { "_id": 0, "value": 1 })
            .await?;
        match stored.map(|stored| stored.value) {
            Some(Bson::Binary(binary)) => Ok(Some(Packed(binary.bytes.into()))),
            Some(other) => Ok(Some(Packed::encode(Arc::new(bson::from_bson::<serde_json::Value>(other)?)).await?)),
            None => Ok(None),
        }
    }

    pub async fn set<T: Serialize>(&self, key: &str, value: &T, ttl: Duration) -> Result<()> {
        let value = if self.compress_values {
            let json = serde_json::to_vec(value)?;
            let compressed =
                tokio::task::spawn_blocking(move || zstd::encode_all(json.as_slice(), ZSTD_LEVEL)).await??;
            Bson::Binary(Binary { subtype: BinarySubtype::Generic, bytes: compressed })
        } else {
            bson::to_bson(value)?
        };
        self.write(key, value, ttl).await
    }

    pub async fn set_packed(&self, key: &str, value: &Packed, ttl: Duration) -> Result<()> {
        let binary = Binary { subtype: BinarySubtype::Generic, bytes: value.0.to_vec() };
        self.write(key, Bson::Binary(binary), ttl).await
    }

    async fn write(&self, key: &str, value: Bson, ttl: Duration) -> Result<()> {
        let expires_at = DateTime::from_millis(DateTime::now().timestamp_millis() + ttl.as_millis() as i64);
        self.collection
            .clone_with_type::<Entry<'_>>()
            .update_one(
                doc! { "key": { "$eq": key } },
                doc! { "$set": bson::to_document(&Entry { key, value, expires_at })? },
            )
            .upsert(true)
            .await?;
        Ok(())
    }

    pub async fn delete(&self, key: &str) -> Result<()> {
        self.collection.delete_one(doc! { "key": { "$eq": key } }).await?;
        Ok(())
    }
}

async fn decode<T: DeserializeOwned + Send + 'static>(value: Bson) -> Result<T> {
    match value {
        Bson::Binary(binary) => {
            tokio::task::spawn_blocking(move || -> Result<T> {
                Ok(serde_json::from_slice(&zstd::decode_all(binary.bytes.as_slice())?)?)
            })
            .await?
        }
        other => Ok(bson::from_bson(other)?),
    }
}
