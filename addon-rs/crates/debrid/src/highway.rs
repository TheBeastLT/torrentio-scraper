use std::collections::HashMap;

use reqwest::Method;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::{Error, Http, Result};

const BASE_URL: &str = "https://cloud.high-way.me/api/transfers.php";

#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct CheckEntry {
    #[serde(default)]
    pub known: bool,
    #[serde(default)]
    pub ready: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct CheckResponse {
    #[serde(default)]
    pub results: HashMap<String, CheckEntry>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Transfer {
    #[serde(default, deserialize_with = "string_or_number")]
    pub id: String,
    #[serde(default, deserialize_with = "string_or_number")]
    pub service: String,
    #[serde(default)]
    pub state: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct File {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub size: f64,
    #[serde(default)]
    pub download_url: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Status {
    #[serde(default)]
    pub files: Vec<File>,
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

    pub async fn check(&self, api_key: &str, hashes: &[String]) -> Result<CheckResponse> {
        let query = [("check", hashes.join(",")), ("service", "torrent".to_owned())];
        let request = self.http.request(Method::GET, &self.base_url).query(&query);
        self.send(api_key, request).await
    }

    pub async fn add(&self, api_key: &str, magnet: &str) -> Result<Transfer> {
        let request = self.http.request(Method::POST, &self.base_url).form(&[("magnet", magnet)]);
        self.send(api_key, request).await
    }

    pub async fn status(&self, api_key: &str, id: &str, service: &str) -> Result<Status> {
        let request = self.http.request(Method::GET, &self.base_url).query(&[("id", id), ("service", service)]);
        self.send(api_key, request).await
    }

    async fn send<T: serde::de::DeserializeOwned>(&self, api_key: &str, request: reqwest::RequestBuilder) -> Result<T> {
        let response = request.bearer_auth(api_key).send().await?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            let body = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
            return Err(Error::api(Some(status.as_u16()), body));
        }
        Ok(response.json().await?)
    }
}

pub fn request_failed_message(status: u16) -> String {
    format!("HighWay API request failed: {status}")
}

fn string_or_number<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<String, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::String(text) => text,
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_string, header, method, path, query_param},
    };

    use super::*;

    async fn setup() -> (MockServer, Client) {
        let server = MockServer::start().await;
        let http = Http::new(Duration::from_secs(5)).expect("http client");
        let client = Client::with_base_url(http, format!("{}/api/transfers.php", server.uri()));
        (server, client)
    }

    #[tokio::test]
    async fn checks_hashes_as_comma_list() {
        let (server, client) = setup().await;
        Mock::given(method("GET"))
            .and(path("/api/transfers.php"))
            .and(header("authorization", "Bearer key"))
            .and(query_param("check", "aa,bb"))
            .and(query_param("service", "torrent"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": { "aa": { "known": true, "ready": true }, "bb": { "known": true, "ready": false } }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let response = client.check("key", &["aa".to_owned(), "bb".to_owned()]).await.expect("check");
        assert!(response.results["aa"].ready);
        assert!(!response.results["bb"].ready);
    }

    #[tokio::test]
    async fn adds_magnet_as_urlencoded_form() {
        let (server, client) = setup().await;
        Mock::given(method("POST"))
            .and(path("/api/transfers.php"))
            .and(header("content-type", "application/x-www-form-urlencoded"))
            .and(body_string("magnet=aabb"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": 42, "service": "torrent", "state": "completed"
            })))
            .expect(1)
            .mount(&server)
            .await;
        let transfer = client.add("key", "aabb").await.expect("add");
        assert_eq!(transfer.id, "42");
        assert_eq!(transfer.service, "torrent");
        assert_eq!(transfer.state, "completed");
    }

    #[tokio::test]
    async fn reads_transfer_status_files() {
        let (server, client) = setup().await;
        Mock::given(method("GET"))
            .and(path("/api/transfers.php"))
            .and(query_param("id", "42"))
            .and(query_param("service", "torrent"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "files": [{ "path": "a/b.mkv", "size": 100, "download_url": "https://dl/b" }]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let status = client.status("key", "42", "torrent").await.expect("status");
        assert_eq!(status.files[0].download_url.as_deref(), Some("https://dl/b"));
    }

    #[tokio::test]
    async fn http_errors_carry_status() {
        let (server, client) = setup().await;
        Mock::given(method("GET")).respond_with(ResponseTemplate::new(401)).mount(&server).await;
        let error = client.check("bad", &["aa".to_owned()]).await.expect_err("unauthorized");
        assert_eq!(error.status(), Some(401));
    }

    #[tokio::test]
    async fn json_error_bodies_are_preserved() {
        let (server, client) = setup().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({ "error": "forbidden" })))
            .mount(&server)
            .await;
        let error = client.add("key", "aa").await.expect_err("forbidden");
        assert_eq!(error.code(), Some("forbidden"));
    }

    #[test]
    fn formats_failure_message_like_the_node_error() {
        assert_eq!(request_failed_message(403), "HighWay API request failed: 403");
    }
}
