use std::time::Duration;

use reqwest::Method;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::{
    Error, Http, Result,
    util::{null_default, parse_or_default},
};

const BASE_URL: &str = "https://www.premiumize.me/api/";
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Content {
    #[serde(default, deserialize_with = "lenient_string")]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub created_at: Option<f64>,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub stream_link: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Folder {
    #[serde(default)]
    pub name: String,
    #[serde(default, deserialize_with = "null_default")]
    pub content: Vec<Content>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Transfer {
    #[serde(default, deserialize_with = "lenient_string")]
    pub id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default, deserialize_with = "lenient_option_string")]
    pub file_id: Option<String>,
    #[serde(default, deserialize_with = "lenient_option_string")]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub src: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct DirectFile {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub size: f64,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub stream_link: Option<String>,
    #[serde(default)]
    pub transcode_status: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct DirectDownload {
    #[serde(default, deserialize_with = "null_default")]
    pub content: Vec<DirectFile>,
}

#[derive(Debug, Default, Deserialize)]
struct CacheCheck {
    #[serde(default, deserialize_with = "null_default")]
    response: Vec<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct TransferList {
    #[serde(default, deserialize_with = "null_default")]
    transfers: Vec<Transfer>,
}

#[derive(Debug, Default, Deserialize)]
struct Created {
    #[serde(default, deserialize_with = "lenient_string")]
    id: String,
}

#[derive(Clone, Debug)]
pub struct Client {
    http: Http,
    base_url: String,
}

impl Client {
    pub fn new(http: Http) -> Self {
        Self { http: http.with_timeout(TIMEOUT), base_url: BASE_URL.to_owned() }
    }

    pub fn with_base_url(http: Http, base_url: impl Into<String>) -> Self {
        Self { http: http.with_timeout(TIMEOUT), base_url: base_url.into() }
    }

    pub async fn check_cache(&self, api_key: &str, hashes: &[String]) -> Result<Vec<bool>> {
        let items = hashes.join(",");
        let data = self.request(api_key, Method::GET, "cache/check", &[("items", &items)], None).await?;
        Ok(parse_or_default::<CacheCheck>(data)?.response)
    }

    pub async fn list_folder(&self, api_key: &str, id: Option<&str>, download_ip: Option<&str>) -> Result<Folder> {
        let query: Vec<(&str, &str)> = [("id", id), ("download_ip", download_ip)]
            .into_iter()
            .filter_map(|(key, value)| Some((key, value?)))
            .collect();
        let data = self.request(api_key, Method::GET, "folder/list", &query, None).await?;
        parse_or_default(data)
    }

    pub async fn list_transfers(&self, api_key: &str) -> Result<Vec<Transfer>> {
        let data = self.request(api_key, Method::GET, "transfer/list", &[], None).await?;
        Ok(parse_or_default::<TransferList>(data)?.transfers)
    }

    pub async fn create_transfer(&self, api_key: &str, src: &str) -> Result<String> {
        let data = self.request(api_key, Method::POST, "transfer/create", &[], Some(&[("src", src)])).await?;
        Ok(parse_or_default::<Created>(data)?.id)
    }

    pub async fn direct_download(&self, api_key: &str, src: &str, download_ip: Option<&str>) -> Result<DirectDownload> {
        let mut form = vec![("src", src)];
        if let Some(ip) = download_ip {
            form.push(("download_ip", ip));
        }
        let data = self.request(api_key, Method::POST, "transfer/directdl", &[], Some(&form)).await?;
        parse_or_default(data)
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
            self.http.request(method, &format!("{}{path}", self.base_url)).query(query).query(&[("apikey", api_key)]);
        if let Some(form) = form {
            request = request.form(form);
        }
        let reply = self.http.send_json_or(request, Error::invalid_response_body).await?;
        if let Some(data) = &reply.data
            && data.get("status").and_then(Value::as_str) == Some("error")
        {
            return Err(Error::api(Some(reply.status), data.clone()));
        }
        if !reply.is_success() {
            return Err(reply.request_failed());
        }
        Ok(reply.into_data())
    }
}

fn lenient_option_string<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::String(text) => Some(text),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

fn lenient_string<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<String, D::Error> {
    lenient_option_string(deserializer).map(Option::unwrap_or_default)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_string_contains, method, path, query_param},
    };

    use super::*;

    const KEY: &str = "secret-key";

    fn client(server: &MockServer) -> Client {
        let http = Http::new(std::time::Duration::from_secs(5)).expect("http client");
        Client::with_base_url(http, format!("{}/api/", server.uri()))
    }

    #[tokio::test]
    async fn check_cache_joins_hashes_and_parses_flags() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/cache/check"))
            .and(query_param("apikey", KEY))
            .and(query_param("items", "aaa,bbb"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "status": "success", "response": [true, false] })),
            )
            .mount(&server)
            .await;
        let result = client(&server).check_cache(KEY, &["aaa".to_owned(), "bbb".to_owned()]).await;
        assert_eq!(result.expect("cache check"), vec![true, false]);
    }

    #[tokio::test]
    async fn list_folder_sends_id_and_download_ip() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/folder/list"))
            .and(query_param("id", "f1"))
            .and(query_param("download_ip", "1.2.3.4"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "success",
                "name": "Root",
                "content": [{ "id": "a", "name": "Sub", "type": "folder" }, { "id": 7, "name": "v.mkv", "type": "file", "created_at": 1_700_000_000, "link": "http://l" }]
            })))
            .mount(&server)
            .await;
        let folder = client(&server).list_folder(KEY, Some("f1"), Some("1.2.3.4")).await.expect("folder");
        assert_eq!(folder.name, "Root");
        assert_eq!(folder.content[0].kind, "folder");
        assert_eq!(folder.content[1].id, "7");
        assert_eq!(folder.content[1].link.as_deref(), Some("http://l"));
    }

    #[tokio::test]
    async fn list_folder_without_id_lists_root_and_tolerates_null_content() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/folder/list"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "status": "success", "content": null })))
            .mount(&server)
            .await;
        let folder = client(&server).list_folder(KEY, None, None).await.expect("folder");
        assert!(folder.content.is_empty());
    }

    #[tokio::test]
    async fn list_transfers_parses_ids_as_strings() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/transfer/list"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "success",
                "transfers": [{ "id": "t1", "status": "finished", "file_id": null, "folder_id": "f9", "src": "magnet:?xt=urn:btih:abc" }]
            })))
            .mount(&server)
            .await;
        let transfers = client(&server).list_transfers(KEY).await.expect("transfers");
        assert_eq!(transfers[0].id, "t1");
        assert_eq!(transfers[0].file_id, None);
        assert_eq!(transfers[0].folder_id.as_deref(), Some("f9"));
    }

    #[tokio::test]
    async fn create_transfer_posts_form_and_returns_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/transfer/create"))
            .and(query_param("apikey", KEY))
            .and(body_string_contains("src=magnet%3A%3Fxt%3Durn%3Abtih%3Aabc"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "status": "success", "id": "t2" })))
            .mount(&server)
            .await;
        let id = client(&server).create_transfer(KEY, "magnet:?xt=urn:btih:abc").await.expect("create");
        assert_eq!(id, "t2");
    }

    #[tokio::test]
    async fn direct_download_posts_src_and_ip() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/transfer/directdl"))
            .and(body_string_contains("download_ip=9.9.9.9"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "success",
                "content": [{ "path": "a/b.mkv", "size": 10, "link": "http://l", "stream_link": "http://s", "transcode_status": "finished" }]
            })))
            .mount(&server)
            .await;
        let result = client(&server).direct_download(KEY, "magnet:?xt=urn:btih:abc", Some("9.9.9.9")).await;
        let file = &result.expect("direct download").content[0];
        assert_eq!(file.path, "a/b.mkv");
        assert_eq!(file.transcode_status.as_deref(), Some("finished"));
    }

    #[tokio::test]
    async fn status_error_body_is_returned_as_api_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/transfer/list"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "status": "error", "message": "Not logged in." })),
            )
            .mount(&server)
            .await;
        let error = client(&server).list_transfers(KEY).await.expect_err("api error");
        assert_eq!(error.body().and_then(|body| body.get("message")).and_then(Value::as_str), Some("Not logged in."));
    }

    #[tokio::test]
    async fn http_failure_without_status_error_gets_synthetic_message() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/transfer/list"))
            .respond_with(ResponseTemplate::new(502).set_body_string("bad gateway"))
            .mount(&server)
            .await;
        let error = client(&server).list_transfers(KEY).await.expect_err("api error");
        assert_eq!(error.status(), Some(502));
        let message = error.body().and_then(|body| body.get("message")).and_then(Value::as_str).unwrap_or_default();
        assert!(message.starts_with("Invalid response (502)"));
    }
}
