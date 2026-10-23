use reqwest::Method;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::{
    Error, Http, Result,
    util::{is_truthy, null_default, parse_or_default},
};

const BASE_URL: &str = "https://debrid-link.fr/api/v2/";
const PAGE_SIZE: u32 = 50;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct File {
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "downloadUrl")]
    pub download_url: Option<String>,
    #[serde(default, rename = "downloadPercent")]
    pub download_percent: Option<f64>,
    #[serde(default)]
    pub size: f64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Torrent {
    #[serde(default, deserialize_with = "lenient_string")]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "hashString")]
    pub hash_string: String,
    #[serde(default)]
    pub created: f64,
    #[serde(default, rename = "downloadPercent")]
    pub download_percent: Option<f64>,
    #[serde(default, deserialize_with = "null_default")]
    pub files: Vec<File>,
}

#[derive(Debug, Default, Deserialize)]
struct Listing {
    #[serde(default, deserialize_with = "null_default")]
    value: Vec<Torrent>,
}

#[derive(Debug, Default, Deserialize)]
struct Added {
    #[serde(default)]
    value: Option<Torrent>,
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

    pub async fn list(&self, api_key: &str, ids: Option<&str>, ip: Option<&str>) -> Result<Vec<Torrent>> {
        let page_size = PAGE_SIZE.to_string();
        let mut query = Vec::new();
        if let Some(ids) = ids {
            query.push(("ids", ids));
        }
        query.push(("page", "0"));
        query.push(("perPage", &page_size));
        if let Some(ip) = ip {
            query.push(("ip", ip));
        }
        let data = self.request(api_key, Method::GET, "seedbox/list", &query, None).await?;
        Ok(parse_or_default::<Listing>(data)?.value)
    }

    pub async fn add_torrent(&self, api_key: &str, magnet: &str, ip: Option<&str>) -> Result<Option<Torrent>> {
        let mut form = vec![("url", magnet), ("async", "true")];
        if let Some(ip) = ip {
            form.push(("ip", ip));
        }
        let data = self.request(api_key, Method::POST, "seedbox/add", &[], Some(&form)).await?;
        Ok(parse_or_default::<Added>(data)?.value)
    }

    async fn request(
        &self,
        api_key: &str,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        form: Option<&[(&str, &str)]>,
    ) -> Result<Value> {
        let mut request =
            self.http.request(method, &format!("{}{path}", self.base_url)).bearer_auth(api_key).query(query);
        if let Some(form) = form {
            request = request.form(form);
        }
        let reply = self.http.send_json_or(request, Error::invalid_response_body).await?;
        if let Some(data) = &reply.data
            && data.get("error").is_some_and(is_truthy)
        {
            return Err(Error::api(Some(reply.status), data.clone()));
        }
        if !reply.is_success() {
            return Err(reply.request_failed());
        }
        Ok(reply.into_data())
    }
}

fn lenient_string<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<String, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::String(text) => text,
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_string_contains, header, method, path, query_param, query_param_is_missing},
    };

    use super::*;

    const KEY: &str = "secret-key";

    fn client(server: &MockServer) -> Client {
        let http = Http::new(std::time::Duration::from_secs(5)).expect("http client");
        Client::with_base_url(http, format!("{}/api/v2/", server.uri()))
    }

    fn torrent_json() -> Value {
        json!({
            "id": "t1",
            "name": "Show",
            "hashString": "ABCDEF",
            "created": 1_700_000_000,
            "downloadPercent": 100,
            "files": [{ "name": "a.mkv", "downloadUrl": "http://dl/a", "downloadPercent": 100, "size": 5 }]
        })
    }

    #[tokio::test]
    async fn list_sends_bearer_paging_and_ip() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v2/seedbox/list"))
            .and(header("authorization", "Bearer secret-key"))
            .and(query_param("page", "0"))
            .and(query_param("perPage", "50"))
            .and(query_param("ip", "1.2.3.4"))
            .and(query_param("ids", "t1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "success": true, "value": [torrent_json()] })),
            )
            .mount(&server)
            .await;
        let torrents = client(&server).list(KEY, Some("t1"), Some("1.2.3.4")).await.expect("list");
        assert_eq!(torrents[0].hash_string, "ABCDEF");
        assert_eq!(torrents[0].files[0].download_url.as_deref(), Some("http://dl/a"));
        assert_eq!(torrents[0].download_percent, Some(100.0));
    }

    #[tokio::test]
    async fn list_omits_ids_and_ip_when_absent() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v2/seedbox/list"))
            .and(query_param_is_missing("ids"))
            .and(query_param_is_missing("ip"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "success": true, "value": [] })))
            .mount(&server)
            .await;
        let torrents = client(&server).list(KEY, None, None).await.expect("list");
        assert!(torrents.is_empty());
    }

    #[tokio::test]
    async fn add_torrent_posts_async_form_without_wait() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/seedbox/add"))
            .and(header("authorization", "Bearer secret-key"))
            .and(body_string_contains("url=magnet%3A%3Fxt%3Durn%3Abtih%3Aabc"))
            .and(body_string_contains("async=true"))
            .and(body_string_contains("ip=1.2.3.4"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "success": true, "value": torrent_json() })))
            .mount(&server)
            .await;
        let added = client(&server).add_torrent(KEY, "magnet:?xt=urn:btih:abc", Some("1.2.3.4")).await;
        assert_eq!(added.expect("add").map(|torrent| torrent.id), Some("t1".to_owned()));
    }

    #[tokio::test]
    async fn error_field_becomes_api_error_with_code() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v2/seedbox/list"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({ "error": "badToken" })))
            .mount(&server)
            .await;
        let error = client(&server).list(KEY, None, None).await.expect_err("api error");
        assert_eq!(error.code(), Some("badToken"));
        assert_eq!(error.status(), Some(400));
    }

    #[tokio::test]
    async fn http_failure_without_error_field_gets_synthetic_message() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v2/seedbox/list"))
            .respond_with(ResponseTemplate::new(503).set_body_json(json!({ "success": false })))
            .mount(&server)
            .await;
        let error = client(&server).list(KEY, None, None).await.expect_err("api error");
        assert_eq!(error.code(), None);
        let message = error.body().and_then(|body| body.get("message")).and_then(Value::as_str).unwrap_or_default();
        assert!(message.starts_with("Request failed (503)"));
    }
}
