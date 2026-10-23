use std::time::Duration;

use reqwest::{Client, RequestBuilder};
use serde_json::{Value, json};

use crate::{Error, Result};

pub const USER_AGENT: &str = "torrentio";

const ERROR_BODY_LIMIT: usize = 200;

#[derive(Clone, Debug)]
pub struct Http {
    client: Client,
    timeout: Duration,
}

#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub text: String,
    pub data: Option<Value>,
}

impl Reply {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn request_failed_message(&self) -> String {
        format!("Request failed ({}): {}", self.status, truncate(&self.text))
    }

    pub fn request_failed(&self) -> Error {
        Error::api(Some(self.status), json!({ "message": self.request_failed_message() }))
    }

    pub fn into_data(self) -> Value {
        self.data.unwrap_or(Value::Null)
    }
}

impl Http {
    pub fn new(timeout: Duration) -> reqwest::Result<Self> {
        let client = Client::builder().user_agent(USER_AGENT).http1_only().pool_max_idle_per_host(64).build()?;
        Ok(Self { client, timeout })
    }

    #[must_use]
    pub fn with_timeout(self, timeout: Duration) -> Self {
        Self { timeout, ..self }
    }

    pub fn request(&self, method: reqwest::Method, url: &str) -> RequestBuilder {
        self.client.request(method, url).timeout(self.timeout)
    }

    pub fn get(&self, url: &str) -> RequestBuilder {
        self.request(reqwest::Method::GET, url)
    }

    pub fn post(&self, url: &str) -> RequestBuilder {
        self.request(reqwest::Method::POST, url)
    }

    pub async fn send_json(&self, request: RequestBuilder) -> Result<Reply> {
        self.send_json_or(request, Error::invalid_response).await
    }

    pub async fn send_json_or(&self, request: RequestBuilder, invalid: fn(u16, &str) -> Error) -> Result<Reply> {
        let response = request.send().await?;
        let status = response.status().as_u16();
        let text = response.text().await?;
        let data =
            if text.is_empty() { None } else { Some(serde_json::from_str(&text).map_err(|_| invalid(status, &text))?) };
        Ok(Reply { status, text, data })
    }
}

pub fn truncate(text: &str) -> String {
    text.chars().take(ERROR_BODY_LIMIT).collect()
}

#[cfg(test)]
mod tests {
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{method, path},
    };

    use super::*;

    fn http() -> Http {
        Http::new(Duration::from_secs(5)).expect("http client")
    }

    async fn reply_for(template: ResponseTemplate) -> (Result<Reply>, MockServer) {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/x")).respond_with(template).mount(&server).await;
        let http = http();
        let result = http.send_json(http.get(&format!("{}/x", server.uri()))).await;
        (result, server)
    }

    #[test]
    fn truncate_limits_characters() {
        assert_eq!(truncate(&"é".repeat(300)).chars().count(), 200);
        assert_eq!(truncate("short"), "short");
    }

    #[test]
    fn with_timeout_replaces_timeout_only() {
        let http = http().with_timeout(Duration::from_secs(15));
        assert_eq!(http.timeout, Duration::from_secs(15));
    }

    #[tokio::test]
    async fn parses_json_body() {
        let (result, _server) = reply_for(ResponseTemplate::new(200).set_body_json(json!({ "a": 1 }))).await;
        let reply = result.expect("reply");
        assert!(reply.is_success());
        assert_eq!(reply.status, 200);
        assert_eq!(reply.into_data(), json!({ "a": 1 }));
    }

    #[tokio::test]
    async fn empty_body_has_no_data() {
        let (result, _server) = reply_for(ResponseTemplate::new(500)).await;
        let reply = result.expect("reply");
        assert!(!reply.is_success());
        assert!(reply.data.is_none());
        assert_eq!(reply.request_failed_message(), "Request failed (500): ");
        assert_eq!(reply.into_data(), Value::Null);
    }

    #[tokio::test]
    async fn invalid_json_is_reported_with_truncated_text() {
        let (result, _server) = reply_for(ResponseTemplate::new(502).set_body_string("x".repeat(300))).await;
        let error = result.expect_err("invalid");
        assert_eq!(error.to_string(), format!("Invalid response (502): {}", "x".repeat(200)));
    }

    #[tokio::test]
    async fn invalid_json_uses_custom_mapper() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string("nope"))
            .mount(&server)
            .await;
        let http = http();
        let error =
            http.send_json_or(http.get(&server.uri()), Error::invalid_response_body).await.expect_err("invalid");
        assert_eq!(error.body(), Some(&json!({ "message": "Invalid response (200): nope" })));
    }

    #[tokio::test]
    async fn request_failed_wraps_message_in_api_error() {
        let (result, _server) = reply_for(ResponseTemplate::new(503).set_body_json(json!({ "a": 1 }))).await;
        let error = result.expect("reply").request_failed();
        assert_eq!(error.status(), Some(503));
        assert_eq!(error.body(), Some(&json!({ "message": "Request failed (503): {\"a\":1}" })));
    }
}
