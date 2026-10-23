use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Error, Http, Result, util::parse_value};

const BASE_URL: &str = "https://api.alldebrid.com";
const AGENT: &str = "torrentio";

#[derive(Clone, Copy, Debug)]
pub struct Auth<'a> {
    pub api_key: &'a str,
    pub ip: Option<&'a str>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Link {
    #[serde(default)]
    pub filename: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Magnet {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub hash: String,
    #[serde(default, rename = "statusCode")]
    pub status_code: Option<i64>,
    #[serde(default, rename = "uploadDate")]
    pub upload_date: i64,
    #[serde(default)]
    pub links: Vec<Link>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct File {
    #[serde(default)]
    pub n: String,
    #[serde(default)]
    pub s: i64,
    #[serde(default)]
    pub l: String,
}

#[derive(Debug, Default, Deserialize)]
struct Node {
    #[serde(default)]
    n: String,
    #[serde(default)]
    s: i64,
    #[serde(default)]
    l: String,
    #[serde(default)]
    e: Option<Vec<Node>>,
}

#[derive(Debug, Default, Deserialize)]
struct Uploaded {
    #[serde(default)]
    id: Option<i64>,
    #[serde(default)]
    error: Option<Value>,
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

    pub async fn upload_magnet(&self, auth: Auth<'_>, magnet: &str) -> Result<i64> {
        let body = self.request(auth, Method::POST, "/v4/magnet/upload", &[], &[("magnets", magnet)]).await?;
        let first = body.pointer("/data/magnets/0").cloned().unwrap_or(Value::Null);
        let uploaded: Uploaded = serde_json::from_value(first).unwrap_or_default();
        match uploaded {
            Uploaded { id: Some(id), .. } if id != 0 => Ok(id),
            Uploaded { error: Some(error), .. } if !error.is_null() => Err(Error::api(None, error)),
            _ => Err(Error::Other(format!("No magnet added with response: {body}"))),
        }
    }

    pub async fn magnet(&self, auth: Auth<'_>, id: i64) -> Result<Option<Magnet>> {
        let id = id.to_string();
        let body = self.request(auth, Method::GET, "/v4.1/magnet/status", &[("id", &id)], &[]).await?;
        match body.pointer("/data/magnets") {
            Some(Value::Array(magnets)) => magnets.first().cloned().map(parse_value).transpose(),
            Some(Value::Object(_)) => body.pointer("/data/magnets").cloned().map(parse_value).transpose(),
            _ => Ok(None),
        }
    }

    pub async fn magnets(&self, auth: Auth<'_>) -> Result<Vec<Magnet>> {
        let body = self.request(auth, Method::GET, "/v4.1/magnet/status", &[], &[]).await?;
        match body.pointer("/data/magnets") {
            Some(Value::Array(magnets)) => magnets.iter().cloned().map(parse_value).collect(),
            _ => Ok(Vec::new()),
        }
    }

    pub async fn files(&self, auth: Auth<'_>, id: i64) -> Result<Vec<File>> {
        let id = id.to_string();
        let body = self.request(auth, Method::GET, "/v4/magnet/files", &[("id[]", &id)], &[]).await?;
        let nodes: Vec<Node> = match body.pointer("/data/magnets/0/files") {
            Some(files) => parse_value(files.clone())?,
            None => Vec::new(),
        };
        let mut files = Vec::new();
        flatten(nodes, &mut files);
        Ok(files)
    }

    pub async fn delete_magnet(&self, auth: Auth<'_>, id: i64) -> Result<()> {
        let id = id.to_string();
        self.request(auth, Method::GET, "/v4/magnet/delete", &[("id", &id)], &[]).await.map(drop)
    }

    pub async fn unlock(&self, auth: Auth<'_>, link: &str) -> Result<String> {
        let body = self.request(auth, Method::GET, "/v4/link/unlock", &[("link", link)], &[]).await?;
        body.pointer("/data/link")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| Error::Other(format!("No unlocked link in response: {body}")))
    }

    async fn request(
        &self,
        auth: Auth<'_>,
        method: Method,
        path: &str,
        params: &[(&str, &str)],
        form: &[(&str, &str)],
    ) -> Result<Value> {
        let mut query: Vec<(&str, &str)> = params.to_vec();
        if let Some(ip) = auth.ip {
            query.push(("ip", ip));
        }
        query.push(("agent", AGENT));
        let mut request =
            self.http.request(method, &format!("{}{path}", self.base_url)).bearer_auth(auth.api_key).query(&query);
        if !form.is_empty() {
            request = request.form(form);
        }
        let reply = self.http.send_json(request).await?;
        if let Some(body) = &reply.data
            && body.get("status").and_then(Value::as_str) == Some("error")
        {
            return Err(Error::api(Some(reply.status), body.get("error").cloned().unwrap_or(Value::Null)));
        }
        if !reply.is_success() {
            return Err(reply.request_failed());
        }
        Ok(reply.into_data())
    }
}

pub fn error_code(error: &Error) -> Option<&str> {
    error.body()?.get("code")?.as_str()
}

pub fn error_message(error: &Error) -> String {
    match error.body().and_then(|body| body.get("message")).and_then(Value::as_str) {
        Some(message) => message.to_owned(),
        None => error.to_string(),
    }
}

fn flatten(nodes: Vec<Node>, files: &mut Vec<File>) {
    for node in nodes {
        match node.e {
            Some(children) => flatten(children, files),
            None => files.push(File { n: node.n, s: node.s, l: node.l }),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use std::time::Duration;

    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_string_contains, header, method, path, query_param},
    };

    use super::*;

    const KEY: &str = "secret-key";

    fn auth() -> Auth<'static> {
        Auth { api_key: KEY, ip: Some("1.2.3.4") }
    }

    fn client(server: &MockServer) -> Client {
        let http = Http::new(Duration::from_secs(5)).expect("http client");
        Client::with_base_url(http, server.uri())
    }

    #[tokio::test]
    async fn upload_posts_form_with_auth_ip_and_agent() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v4/magnet/upload"))
            .and(header("authorization", "Bearer secret-key"))
            .and(query_param("ip", "1.2.3.4"))
            .and(query_param("agent", "torrentio"))
            .and(body_string_contains("magnets=magnet%3A%3Fxt%3Durn%3Abtih%3Aabc"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(
                    json!({ "status": "success", "data": { "magnets": [{ "id": 42, "hash": "abc" }] } }),
                ),
            )
            .mount(&server)
            .await;
        let id = client(&server).upload_magnet(auth(), "magnet:?xt=urn:btih:abc").await;
        assert_eq!(id.expect("uploaded"), 42);
    }

    #[tokio::test]
    async fn upload_surfaces_per_magnet_error_object() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v4/magnet/upload"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "success",
                "data": { "magnets": [{ "magnet": "x", "error": { "code": "MAGNET_TOO_MANY", "message": "Too many" } }] }
            })))
            .mount(&server)
            .await;
        let error = client(&server).upload_magnet(auth(), "x").await.expect_err("rejected");
        assert_eq!(error_code(&error), Some("MAGNET_TOO_MANY"));
        assert_eq!(error_message(&error), "Too many");
    }

    #[tokio::test]
    async fn upload_without_id_or_error_reports_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v4/magnet/upload"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "status": "success", "data": {} })))
            .mount(&server)
            .await;
        let error = client(&server).upload_magnet(auth(), "x").await.expect_err("rejected");
        assert!(error.to_string().starts_with("No magnet added with response:"));
    }

    #[tokio::test]
    async fn api_error_status_maps_to_error_object() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v4.1/magnet/status"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({ "status": "error", "error": { "code": "AUTH_BAD_APIKEY", "message": "bad key" } }),
            ))
            .mount(&server)
            .await;
        let error = client(&server).magnets(auth()).await.expect_err("rejected");
        assert_eq!(error_code(&error), Some("AUTH_BAD_APIKEY"));
        assert_eq!(error.status(), Some(200));
    }

    #[tokio::test]
    async fn http_failure_without_error_status_keeps_message() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v4.1/magnet/status"))
            .respond_with(ResponseTemplate::new(502).set_body_json(json!({ "oops": true })))
            .mount(&server)
            .await;
        let error = client(&server).magnets(auth()).await.expect_err("rejected");
        assert!(error_message(&error).starts_with("Request failed (502):"));
        assert_eq!(error_code(&error), None);
    }

    #[tokio::test]
    async fn invalid_json_is_reported() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v4.1/magnet/status"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>"))
            .mount(&server)
            .await;
        let error = client(&server).magnets(auth()).await.expect_err("rejected");
        assert_eq!(error.to_string(), "Invalid response (200): <html>");
    }

    #[tokio::test]
    async fn status_by_id_parses_magnet() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v4.1/magnet/status"))
            .and(query_param("id", "7"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "success",
                "data": { "magnets": {
                    "id": 7, "filename": "Movie", "hash": "ABC", "statusCode": 4, "uploadDate": 1_700_000_000,
                    "links": [{ "filename": "Movie.mkv" }]
                } }
            })))
            .mount(&server)
            .await;
        let magnet = client(&server).magnet(auth(), 7).await.expect("status").expect("magnet");
        assert_eq!(magnet.status_code, Some(4));
        assert_eq!(magnet.hash, "ABC");
        assert_eq!(magnet.links[0].filename, "Movie.mkv");
        assert_eq!(magnet.upload_date, 1_700_000_000);
    }

    #[tokio::test]
    async fn status_list_has_no_id_param_and_parses_array() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v4.1/magnet/status"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "success",
                "data": { "magnets": [{ "id": 1, "statusCode": 4 }, { "id": 2, "statusCode": 1 }] }
            })))
            .mount(&server)
            .await;
        let magnets = client(&server).magnets(auth()).await.expect("list");
        assert_eq!(magnets.iter().map(|magnet| magnet.id).collect::<Vec<_>>(), vec![1, 2]);
        let requests = server.received_requests().await.expect("requests");
        assert!(requests[0].url.query_pairs().all(|(key, _)| key != "id"));
    }

    #[tokio::test]
    async fn files_are_flattened_from_nested_tree() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v4/magnet/files"))
            .and(query_param("id[]", "7"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "success",
                "data": { "magnets": [{ "id": "7", "files": [
                    { "n": "dir", "e": [{ "n": "a.mkv", "s": 10, "l": "link-a" }, { "n": "sub", "e": [{ "n": "b.mkv", "s": 20, "l": "link-b" }] }] },
                    { "n": "c.nfo", "s": 1, "l": "link-c" }
                ] }] }
            })))
            .mount(&server)
            .await;
        let files = client(&server).files(auth(), 7).await.expect("files");
        let names: Vec<&str> = files.iter().map(|file| file.n.as_str()).collect();
        assert_eq!(names, vec!["a.mkv", "b.mkv", "c.nfo"]);
        assert_eq!(files[1].l, "link-b");
        assert_eq!(files[1].s, 20);
    }

    #[tokio::test]
    async fn unlock_returns_link() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v4/link/unlock"))
            .and(query_param("link", "https://alldebrid.com/f/abc"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "status": "success", "data": { "link": "https://cdn.example/video.mkv" } })),
            )
            .mount(&server)
            .await;
        let link = client(&server).unlock(auth(), "https://alldebrid.com/f/abc").await.expect("link");
        assert_eq!(link, "https://cdn.example/video.mkv");
    }

    #[tokio::test]
    async fn delete_sends_id() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v4/magnet/delete"))
            .and(query_param("id", "9"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "status": "success", "data": {} })))
            .expect(1)
            .mount(&server)
            .await;
        client(&server).delete_magnet(auth(), 9).await.expect("deleted");
    }

    #[tokio::test]
    async fn ip_is_omitted_when_unknown() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v4.1/magnet/status"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "status": "success", "data": { "magnets": [] } })),
            )
            .mount(&server)
            .await;
        let anonymous = Auth { api_key: KEY, ip: None };
        client(&server).magnets(anonymous).await.expect("list");
        let requests = server.received_requests().await.expect("requests");
        assert!(requests[0].url.query_pairs().all(|(key, _)| key != "ip"));
    }
}
