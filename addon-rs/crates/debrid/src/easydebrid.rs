use serde::Deserialize;
use serde_json::{Value, json};

use crate::{Error, Http, Result, util::parse_value};

const BASE_URL: &str = "https://easydebrid.com/api/v1";

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Lookup {
    #[serde(default)]
    pub cached: Vec<bool>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct File {
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub directory: Vec<String>,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub url: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Generated {
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

    pub async fn link_lookup(&self, api_key: &str, urls: &[String]) -> Result<Lookup> {
        self.post(api_key, "/link/lookup", json!({ "urls": urls })).await
    }

    pub async fn generate_link(&self, api_key: &str, url: &str) -> Result<Generated> {
        self.post(api_key, "/link/generate", json!({ "url": url })).await
    }

    async fn post<T: serde::de::DeserializeOwned>(&self, api_key: &str, path: &str, body: Value) -> Result<T> {
        let request = self.http.post(&format!("{}{path}", self.base_url)).bearer_auth(api_key).json(&body);
        let reply = self.http.send_json_or(request, invalid_body).await?;
        if !reply.is_success() {
            let mut body = reply.data.unwrap_or(Value::Null);
            if body.get("message").and_then(Value::as_str).is_none_or(str::is_empty) {
                body = json!({ "message": status_message(reply.status) });
            }
            return Err(Error::api(Some(reply.status), body));
        }
        let data = reply.data.ok_or_else(|| Error::invalid_response(reply.status, &reply.text))?;
        parse_value(data)
    }
}

fn status_message(status: u16) -> String {
    format!("Request failed with status code {status}")
}

fn invalid_body(status: u16, text: &str) -> Error {
    if (200..300).contains(&status) {
        Error::invalid_response(status, text)
    } else {
        Error::api(Some(status), json!({ "message": status_message(status) }))
    }
}

pub fn error_message(error: &Error) -> String {
    match error.body().and_then(|body| body.get("message")).and_then(Value::as_str) {
        Some(message) => message.to_owned(),
        None => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_json, header, method, path},
    };

    use super::*;

    fn client(server: &MockServer) -> Client {
        let http = Http::new(Duration::from_secs(5)).expect("http client");
        Client::with_base_url(http, server.uri())
    }

    #[tokio::test]
    async fn lookup_posts_urls_and_parses_cached_flags() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/link/lookup"))
            .and(header("authorization", "Bearer token"))
            .and(body_json(json!({ "urls": ["aaa", "bbb"] })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "cached": [true, false] })))
            .mount(&server)
            .await;
        let lookup = client(&server).link_lookup("token", &["aaa".to_owned(), "bbb".to_owned()]).await.expect("lookup");
        assert_eq!(lookup.cached, vec![true, false]);
    }

    #[tokio::test]
    async fn generate_posts_magnet_and_parses_files() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/link/generate"))
            .and(body_json(json!({ "url": "magnet:?xt=urn:btih:aaa" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "files": [{ "filename": "a.mkv", "directory": ["dir", "sub"], "size": 5, "url": "https://cdn/a.mkv" }]
            })))
            .mount(&server)
            .await;
        let generated = client(&server).generate_link("token", "magnet:?xt=urn:btih:aaa").await.expect("files");
        assert_eq!(generated.files[0].directory, vec!["dir", "sub"]);
        assert_eq!(generated.files[0].url, "https://cdn/a.mkv");
        assert_eq!(generated.files[0].size, 5);
    }

    #[tokio::test]
    async fn failure_keeps_api_message() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/link/lookup"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({ "message": "Not logged in." })))
            .mount(&server)
            .await;
        let error = client(&server).link_lookup("token", &[]).await.expect_err("rejected");
        assert_eq!(error_message(&error), "Not logged in.");
        assert_eq!(error.status(), Some(401));
    }

    #[tokio::test]
    async fn failure_without_message_falls_back_to_status_text() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/link/generate"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&server)
            .await;
        let error = client(&server).generate_link("token", "x").await.expect_err("rejected");
        assert_eq!(error_message(&error), "Request failed with status code 500");
    }

    #[tokio::test]
    async fn non_json_success_body_reports_status_and_text() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/link/lookup"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>maintenance"))
            .mount(&server)
            .await;
        let error = client(&server).link_lookup("token", &[]).await.expect_err("not json");
        assert_eq!(error.to_string(), "Invalid response (200): <html>maintenance");
    }
}
