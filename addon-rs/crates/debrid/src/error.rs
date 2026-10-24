use std::fmt::Write;

use serde_json::{Value, json};

use crate::http::truncate;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{}", display_body(.body))]
    Api { status: Option<u16>, body: Value },
    #[error("{}", transport_message(.0))]
    Transport(#[from] reqwest::Error),
    #[error("{0}")]
    Other(String),
}

impl Error {
    pub fn api(status: Option<u16>, body: Value) -> Self {
        Self::Api { status, body }
    }

    pub fn invalid_response(status: u16, text: &str) -> Self {
        Self::Other(invalid_response_message(status, text))
    }

    pub fn invalid_response_body(status: u16, text: &str) -> Self {
        Self::api(Some(status), json!({ "message": invalid_response_message(status, text) }))
    }

    pub fn body(&self) -> Option<&Value> {
        match self {
            Self::Api { body, .. } => Some(body),
            _ => None,
        }
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Api { status, .. } => *status,
            Self::Transport(error) => error.status().map(|status| status.as_u16()),
            Self::Other(_) => None,
        }
    }

    pub fn code(&self) -> Option<&str> {
        self.body()?.get("error")?.as_str()
    }

    pub fn detail(&self) -> Option<&str> {
        self.body()?.get("detail")?.as_str()
    }

    pub fn is_timeout(&self) -> bool {
        matches!(self, Self::Transport(error) if error.is_timeout())
    }
}

fn transport_message(error: &reqwest::Error) -> String {
    let kind = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_decode() {
        "decode"
    } else if error.is_body() {
        "body"
    } else if error.is_request() {
        "request"
    } else {
        "other"
    };
    let mut message = format!("{kind} error");
    if let Some(url) = error.url() {
        let _ = write!(message, " for {}", url.path());
    }
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        let _ = write!(message, ": {cause}");
        source = cause.source();
    }
    message
}

fn display_body(body: &Value) -> String {
    body.to_string()
}

fn invalid_response_message(status: u16, text: &str) -> String {
    format!("Invalid response ({status}): {}", truncate(text))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn refused_connection_reports_kind_cause_and_no_query() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        drop(listener);
        let client = reqwest::Client::new();
        let error = client
            .get(format!("http://{address}/rest/info"))
            .query(&[("apikey", "secret")])
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .expect_err("refused");
        let message = Error::from(error).to_string();
        assert!(message.starts_with("connect error for /rest/info: "), "{message}");
        assert!(message.to_lowercase().contains("refused"), "{message}");
        assert!(!message.contains("secret"));
    }

    #[test]
    fn invalid_response_shapes() {
        assert_eq!(Error::invalid_response(500, "bad").to_string(), "Invalid response (500): bad");
        assert_eq!(
            Error::invalid_response_body(500, "bad").body(),
            Some(&json!({ "message": "Invalid response (500): bad" }))
        );
    }
}
