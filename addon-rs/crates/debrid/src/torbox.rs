use std::collections::HashMap;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

use crate::{Error, Http, Result};

const BASE_URL: &str = "https://api.torbox.app/v1";
const PAGE_LIMIT: u32 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Torrents,
    Usenet,
    WebDl,
}

impl Kind {
    pub fn path(self) -> &'static str {
        match self {
            Self::Torrents => "torrents",
            Self::Usenet => "usenet",
            Self::WebDl => "webdl",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "torrents" => Some(Self::Torrents),
            "usenet" => Some(Self::Usenet),
            "webdl" => Some(Self::WebDl),
            _ => None,
        }
    }

    fn id_key(self) -> &'static str {
        match self {
            Self::Torrents => "torrent_id",
            Self::Usenet => "usenet_id",
            Self::WebDl => "web_id",
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct File {
    pub id: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub short_name: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub zipped: bool,
    #[serde(default)]
    pub opensubtitles_hash: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Item {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub files: Vec<File>,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub download_present: bool,
    #[serde(default)]
    pub download_finished: bool,
    #[serde(default)]
    pub download_state: String,
    #[serde(default)]
    pub queued_id: Option<i64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct CachedTorrent {
    pub hash: String,
    #[serde(default)]
    pub files: Vec<File>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Created {
    #[serde(default)]
    pub torrent_id: Option<i64>,
    #[serde(default)]
    pub queued_id: Option<i64>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Client {
    http: Http,
    base_url: String,
}

impl Client {
    pub fn new(http: Http) -> Self {
        Self { http, base_url: BASE_URL.to_owned() }
    }

    pub fn with_base_url(http: Http, base_url: impl Into<String>) -> Self {
        Self { http, base_url: base_url.into() }
    }

    pub async fn check_cached(&self, api_key: &str, hashes: &[String]) -> Result<Vec<CachedTorrent>> {
        let data = self
            .request(
                api_key,
                Method::POST,
                "/api/torrents/checkcached",
                &[("format", "list")],
                Body::Json(json!({ "hashes": hashes })),
            )
            .await?;
        Ok(from_data(data)?.unwrap_or_default())
    }

    pub async fn create_torrent(&self, api_key: &str, magnet: &str, allow_zip: bool) -> Result<Created> {
        let form = [("magnet", magnet.to_owned()), ("allow_zip", allow_zip.to_string())];
        let data = self.request(api_key, Method::POST, "/api/torrents/createtorrent", &[], Body::Form(&form)).await?;
        Ok(from_data(data)?.unwrap_or_default())
    }

    pub async fn control_torrent(&self, api_key: &str, torrent_id: i64, operation: &str) -> Result<()> {
        let body = json!({ "torrent_id": torrent_id, "operation": operation });
        self.request(api_key, Method::POST, "/api/torrents/controltorrent", &[], Body::Json(body)).await.map(drop)
    }

    pub async fn list(&self, api_key: &str, kind: Kind, offset: u32) -> Result<Vec<Item>> {
        let query = [("offset", offset.to_string()), ("limit", PAGE_LIMIT.to_string())];
        let query: Vec<(&str, &str)> = query.iter().map(|(key, value)| (*key, value.as_str())).collect();
        let data =
            self.request(api_key, Method::GET, &format!("/api/{}/mylist", kind.path()), &query, Body::None).await?;
        let mut items: Vec<Item> = from_data(data)?.unwrap_or_default();
        items.sort_by_key(|item| std::cmp::Reverse(item.id));
        Ok(items)
    }

    pub async fn get(&self, api_key: &str, kind: Kind, id: i64) -> Result<Option<Item>> {
        let id = id.to_string();
        let data = self
            .request(api_key, Method::GET, &format!("/api/{}/mylist", kind.path()), &[("id", &id)], Body::None)
            .await?;
        match data {
            Value::Array(_) => Ok(from_data::<Vec<Item>>(data)?.and_then(|items| items.into_iter().next())),
            other => from_data(other),
        }
    }

    pub fn download_link(&self, token: &str, kind: Kind, root_id: &str, file_id: &str) -> String {
        let mut url = Url::parse(&format!("{}/api/{}/requestdl", self.base_url, kind.path()))
            .expect("torbox base url is a valid url");
        url.query_pairs_mut()
            .append_pair("token", token)
            .append_pair(kind.id_key(), root_id)
            .append_pair("file_id", file_id)
            .append_pair("redirect", "true");
        url.into()
    }

    async fn request(
        &self,
        api_key: &str,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Body<'_>,
    ) -> Result<Value> {
        let mut request = self.http.request(method, &format!("{}{}", self.base_url, path)).bearer_auth(api_key);
        if !query.is_empty() {
            request = request.query(query);
        }
        request = match body {
            Body::None => request,
            Body::Json(value) => request.json(&value),
            Body::Form(pairs) => request.form(pairs),
        };
        let response = request.send().await?;
        let status = response.status().as_u16();
        let result: Value = response.json().await.map_err(Error::from)?;
        if result.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(Error::api(Some(status), result));
        }
        Ok(result.get("data").cloned().unwrap_or(Value::Null))
    }
}

enum Body<'a> {
    None,
    Json(Value),
    Form(&'a [(&'a str, String)]),
}

fn from_data<T: serde::de::DeserializeOwned>(data: Value) -> Result<Option<T>> {
    if data.is_null() {
        return Ok(None);
    }
    serde_json::from_value(data).map(Some).map_err(|error| Error::Other(error.to_string()))
}

pub fn index_by_hash(cached: Vec<CachedTorrent>) -> HashMap<String, CachedTorrent> {
    cached.into_iter().map(|torrent| (torrent.hash.clone(), torrent)).collect()
}
