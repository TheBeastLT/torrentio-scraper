use reqwest::{Method, header::RANGE};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};

use crate::{
    Error, Http, Result,
    util::{null_default, parse_value},
};

const BASE_URL: &str = "https://www.deepbrid.com/api/v1";
const NO_DATA: i64 = 1;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Torrent {
    #[serde(default, deserialize_with = "lenient_string")]
    pub id: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub progress: Option<f64>,
    #[serde(default, deserialize_with = "null_default")]
    pub links: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct Added {
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
        Self { http, base_url: BASE_URL.to_owned() }
    }

    pub fn with_base_url(http: Http, base_url: impl Into<String>) -> Self {
        Self { http, base_url: base_url.into() }
    }

    pub async fn add_torrent(&self, api_key: &str, magnet: &str) -> Result<String> {
        let data = self.request(api_key, Method::POST, "/torrents/add", &[], Some(&[("magnet", magnet)])).await?;
        let added: Added = parse_value(data)?;
        if added.id.is_empty() {
            return Err(Error::Other("Deepbrid did not return a torrent id".to_owned()));
        }
        Ok(added.id)
    }

    pub async fn torrent(&self, api_key: &str, id: &str) -> Result<Torrent> {
        let data = self.request(api_key, Method::GET, "/torrents/info", &[("id", id)], None).await?;
        parse_value(data)
    }

    pub async fn list(&self, api_key: &str) -> Result<Vec<Torrent>> {
        let data = match self.request(api_key, Method::GET, "/torrents/info", &[], None).await {
            Err(error) if error_code(&error) == Some(NO_DATA) => return Ok(Vec::new()),
            other => other?,
        };
        let Value::Object(entries) = data else { return Ok(Vec::new()) };
        Ok(entries.into_values().filter(Value::is_object).filter_map(|entry| parse_value(entry).ok()).collect())
    }

    pub async fn delete_torrent(&self, api_key: &str, id: &str) -> Result<()> {
        self.request(api_key, Method::DELETE, &format!("/torrents/delete/{id}"), &[], None).await.map(|_| ())
    }

    /// Follows a torrent link to the download server and returns the final url, which carries the file name.
    pub async fn link_target(&self, link: &str) -> Result<String> {
        let response = self.http.get(link).header(RANGE, "bytes=0-0").send().await?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Err(Error::api(Some(status), json!({ "message": format!("Link not ready ({status})") })));
        }
        Ok(response.url().to_string())
    }

    async fn request(
        &self,
        api_key: &str,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        form: Option<&[(&str, &str)]>,
    ) -> Result<Value> {
        let mut request = self
            .http
            .request(method, &format!("{}{path}", self.base_url))
            .bearer_auth(api_key)
            .header(reqwest::header::ACCEPT, "application/json")
            .query(query);
        if let Some(form) = form {
            request = request.form(form);
        }
        let reply = self.http.send_json_or(request, Error::invalid_response_body).await?;
        if let Some(data) = &reply.data
            && data.get("error").and_then(Value::as_i64).is_some_and(|code| code != 0)
        {
            return Err(Error::api(Some(reply.status), data.clone()));
        }
        if !reply.is_success() {
            return Err(reply.request_failed());
        }
        Ok(reply.into_data())
    }
}

/// Deepbrid reports errors as `{"error": <number>, "message": "..."}`: an HTTP status (401, 403, 429, 503) or a small
/// API code (1 no data, 2 not premium).
pub fn error_code(error: &Error) -> Option<i64> {
    error.body()?.get("error")?.as_i64()
}

pub fn error_message(error: &Error) -> String {
    match error.body().and_then(|body| body.get("message")).and_then(Value::as_str) {
        Some(message) => message.to_owned(),
        None => error.to_string(),
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
    use std::time::Duration;

    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_string, header, method, path, query_param, query_param_is_missing},
    };

    use super::*;

    const KEY: &str = "secret-key";

    fn client(server: &MockServer) -> Client {
        let http = Http::new(Duration::from_secs(5)).expect("http client");
        Client::with_base_url(http, server.uri())
    }

    #[tokio::test]
    async fn add_posts_magnet_and_returns_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/torrents/add"))
            .and(header("authorization", "Bearer secret-key"))
            .and(body_string("magnet=magnet%3A%3Fxt%3Durn%3Abtih%3Aabc"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "error": 0, "message": "OK", "id": 14648 })))
            .mount(&server)
            .await;
        let id = client(&server).add_torrent(KEY, "magnet:?xt=urn:btih:abc").await.expect("added");
        assert_eq!(id, "14648");
    }

    #[tokio::test]
    async fn torrent_reads_status_and_links() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/torrents/info"))
            .and(query_param("id", "14648"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "error": 0, "id": "14648", "filename": "movie", "progress": 100, "status": "downloaded",
                "links": ["https://www.deepbrid.com/mytorrents?torrent=14648&file=Kx7mPq"]
            })))
            .mount(&server)
            .await;
        let torrent = client(&server).torrent(KEY, "14648").await.expect("torrent");
        assert_eq!(torrent.id, "14648");
        assert_eq!(torrent.status, "downloaded");
        assert_eq!(torrent.progress, Some(100.0));
        assert_eq!(torrent.links.len(), 1);
    }

    #[tokio::test]
    async fn list_skips_unreadable_entries_and_treats_no_data_as_empty() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/torrents/info"))
            .and(query_param_is_missing("id"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "1": { "error": 0, "id": "1", "filename": "a", "status": "downloaded", "links": [] },
                "2": { "error": 1, "message": "Error docoding JSON", "id": "2", "filename": "b", "status": "error" },
                "3": "not a torrent"
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        let torrents = client(&server).list(KEY).await.expect("list");
        assert_eq!(torrents.iter().map(|torrent| torrent.id.as_str()).collect::<Vec<_>>(), ["1", "2"]);

        Mock::given(method("GET"))
            .and(path("/torrents/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "error": 1, "message": "No data" })))
            .mount(&server)
            .await;
        assert!(client(&server).list(KEY).await.expect("empty").is_empty());
    }

    #[tokio::test]
    async fn api_errors_keep_code_and_message() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/torrents/add"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_json(json!({ "error": 401, "message": "Authentication required." })),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/torrents/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "error": 2, "message": "Not premium" })))
            .mount(&server)
            .await;
        let unauthorized = client(&server).add_torrent(KEY, "magnet:?xt=urn:btih:abc").await.expect_err("401");
        assert_eq!(error_code(&unauthorized), Some(401));
        assert_eq!(unauthorized.status(), Some(401));
        assert_eq!(error_message(&unauthorized), "Authentication required.");
        let not_premium = client(&server).torrent(KEY, "1").await.expect_err("not premium");
        assert_eq!(error_code(&not_premium), Some(2));
    }

    #[tokio::test]
    async fn delete_uses_the_delete_method() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/torrents/delete/14648"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "error": 0, "deleted": 1, "ids": [14648] })))
            .expect(1)
            .mount(&server)
            .await;
        client(&server).delete_torrent(KEY, "14648").await.expect("deleted");
    }

    #[tokio::test]
    async fn link_target_follows_redirects() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/mytorrents"))
            .respond_with(
                ResponseTemplate::new(302).insert_header("location", format!("{}/dl/Movie.mkv", server.uri())),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/dl/Movie.mkv"))
            .and(header("range", "bytes=0-0"))
            .respond_with(ResponseTemplate::new(206).set_body_bytes(vec![0u8]))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/processing"))
            .respond_with(ResponseTemplate::new(512).set_body_string("Error processing this file..."))
            .mount(&server)
            .await;
        let target = client(&server).link_target(&format!("{}/mytorrents?torrent=1", server.uri())).await;
        assert_eq!(target.expect("target"), format!("{}/dl/Movie.mkv", server.uri()));
        let processing = client(&server).link_target(&format!("{}/processing", server.uri())).await;
        assert_eq!(processing.expect_err("not ready").status(), Some(512));
    }
}
