use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{Error, Http, Result, util::is_truthy};

const BASE_URL: &str = "https://offcloud.com/api";

#[derive(Clone, Debug, Default, Deserialize)]
pub struct CacheInfo {
    #[serde(default)]
    pub cached: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct CachedFile {
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub folder: Option<Vec<String>>,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub url: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct CloudRequest {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct HistoryItem {
    #[serde(default, rename = "requestId")]
    pub request_id: String,
    #[serde(default, rename = "fileName")]
    pub file_name: String,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ExploredFile {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Default, Deserialize)]
struct Explored {
    #[serde(default)]
    files: Vec<ExploredFile>,
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

    pub async fn cache_info(&self, api_key: &str, urls: &[String]) -> Result<Vec<CacheInfo>> {
        let body = json!({ "urls": urls, "includeFiles": false });
        let data = self.request(api_key, Method::POST, "/cache/info", &[], Some(body)).await?;
        Ok(parse_lenient(data))
    }

    pub async fn cache_download(&self, api_key: &str, url: &str) -> Result<Vec<CachedFile>> {
        let data = self.request(api_key, Method::POST, "/cache/download", &[], Some(json!({ "url": url }))).await?;
        Ok(parse_lenient(data))
    }

    pub async fn cloud_download(&self, api_key: &str, url: &str) -> Result<CloudRequest> {
        let data = self.request(api_key, Method::POST, "/cloud", &[], Some(json!({ "url": url }))).await?;
        Ok(parse_lenient(data))
    }

    pub async fn cloud_history(&self, api_key: &str) -> Result<Vec<HistoryItem>> {
        let data = self.request(api_key, Method::GET, "/cloud/history", &[], None).await?;
        Ok(parse_lenient(data))
    }

    pub async fn cloud_explore(&self, api_key: &str, request_id: &str) -> Result<Vec<ExploredFile>> {
        let data = self
            .request(
                api_key,
                Method::GET,
                &format!("/cloud/explore/{}", urlencode(request_id)),
                &[("format", "detailed")],
                None,
            )
            .await?;
        Ok(parse_lenient::<Explored>(data).files)
    }

    async fn request(
        &self,
        api_key: &str,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value> {
        let mut request = self.http.request(method, &format!("{}{path}", self.base_url)).bearer_auth(api_key);
        if !query.is_empty() {
            request = request.query(query);
        }
        if let Some(body) = &body {
            request = request.json(body);
        }
        let reply = self.http.send_json(request).await?;
        let error = reply.data.as_ref().and_then(|data| data.get("error")).filter(|error| is_truthy(error));
        if !reply.is_success() || error.is_some() {
            let error = error.cloned().unwrap_or_else(|| Value::String(reply.request_failed_message()));
            return Err(Error::api(Some(reply.status), json!({ "error": error })));
        }
        Ok(reply.into_data())
    }
}

pub fn error_message(error: &Error) -> String {
    let Some(detail) = error.body().and_then(|body| body.get("error")) else {
        return error.to_string();
    };
    match detail {
        Value::String(message) => message.clone(),
        Value::Object(object) => match object.get("message").and_then(Value::as_str) {
            Some(message) if !message.is_empty() => message.to_owned(),
            _ => "[object Object]".to_owned(),
        },
        other => other.to_string(),
    }
}

fn parse_lenient<T: serde::de::DeserializeOwned + Default>(data: Value) -> T {
    serde_json::from_value(data).unwrap_or_default()
}

fn urlencode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_json, header, method, path, query_param},
    };

    use super::*;

    fn client(server: &MockServer) -> Client {
        let http = Http::new(Duration::from_secs(5)).expect("http client");
        Client::with_base_url(http, server.uri())
    }

    #[tokio::test]
    async fn cache_info_posts_urls_without_files() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/cache/info"))
            .and(header("authorization", "Bearer token"))
            .and(body_json(json!({ "urls": ["magnet:?xt=urn:btih:a"], "includeFiles": false })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([{ "cached": true }])))
            .mount(&server)
            .await;
        let info = client(&server).cache_info("token", &["magnet:?xt=urn:btih:a".to_owned()]).await;
        assert!(info.expect("info")[0].cached);
    }

    #[tokio::test]
    async fn cache_download_parses_files() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/cache/download"))
            .and(body_json(json!({ "url": "magnet" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                { "filename": "a.mkv", "folder": ["dir"], "size": 3, "url": "https://cdn/a.mkv" },
                { "filename": "b.srt", "size": 1, "url": "https://cdn/b.srt" }
            ])))
            .mount(&server)
            .await;
        let files = client(&server).cache_download("token", "magnet").await.expect("files");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].folder.as_deref(), Some(&["dir".to_owned()][..]));
        assert!(files[1].folder.is_none());
    }

    #[tokio::test]
    async fn cloud_download_keeps_full_response_for_logging() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/cloud"))
            .and(body_json(json!({ "url": "magnet" })))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "requestId": "r1", "status": "downloading" })),
            )
            .mount(&server)
            .await;
        let request = client(&server).cloud_download("token", "magnet").await.expect("request");
        assert_eq!(request.status.as_deref(), Some("downloading"));
        assert_eq!(
            serde_json::to_value(&request).expect("json"),
            json!({ "status": "downloading", "requestId": "r1" })
        );
    }

    #[tokio::test]
    async fn history_parses_items() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/cloud/history"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                { "requestId": "r1", "fileName": "Movie", "status": "downloaded" }
            ])))
            .mount(&server)
            .await;
        let history = client(&server).cloud_history("token").await.expect("history");
        assert_eq!(history[0].request_id, "r1");
        assert_eq!(history[0].file_name, "Movie");
        assert_eq!(history[0].status.as_deref(), Some("downloaded"));
    }

    #[tokio::test]
    async fn explore_requests_detailed_format() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/cloud/explore/r1"))
            .and(query_param("format", "detailed"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "files": [{ "path": "Movie/a.mkv", "size": 9, "url": "https://cdn/a.mkv" }]
            })))
            .mount(&server)
            .await;
        let files = client(&server).cloud_explore("token", "r1").await.expect("files");
        assert_eq!(files[0].path, "Movie/a.mkv");
        assert_eq!(files[0].url, "https://cdn/a.mkv");
    }

    #[tokio::test]
    async fn string_error_is_surfaced() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/cache/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "error": "NOAUTH" })))
            .mount(&server)
            .await;
        let error = client(&server).cache_info("token", &[]).await.expect_err("rejected");
        assert_eq!(error_message(&error), "NOAUTH");
        assert_eq!(error.code(), Some("NOAUTH"));
    }

    #[tokio::test]
    async fn object_error_message_is_surfaced() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/cloud"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({ "error": { "message": "not premium" } })))
            .mount(&server)
            .await;
        let error = client(&server).cloud_download("token", "x").await.expect_err("rejected");
        assert_eq!(error_message(&error), "not premium");
        assert_eq!(error.status(), Some(400));
    }

    #[tokio::test]
    async fn http_failure_without_error_field_reports_status() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/cloud/history"))
            .respond_with(ResponseTemplate::new(503).set_body_json(json!({ "ok": false })))
            .mount(&server)
            .await;
        let error = client(&server).cloud_history("token").await.expect_err("rejected");
        assert!(error_message(&error).starts_with("Request failed (503):"));
    }

    #[tokio::test]
    async fn invalid_json_is_reported() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/cloud/history"))
            .respond_with(ResponseTemplate::new(200).set_body_string("nope"))
            .mount(&server)
            .await;
        let error = client(&server).cloud_history("token").await.expect_err("rejected");
        assert_eq!(error.to_string(), "Invalid response (200): nope");
    }
}
