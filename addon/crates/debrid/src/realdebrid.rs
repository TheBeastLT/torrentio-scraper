use reqwest::Method;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::{Error, Http, Result, util::parse_or_default};

const BASE_URL: &str = "https://app.real-debrid.com/rest/1.0";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct TorrentFile {
    pub id: i64,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub bytes: i64,
    #[serde(default, deserialize_with = "flexible_bool")]
    pub selected: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Torrent {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub added: String,
    #[serde(default)]
    pub files: Vec<TorrentFile>,
    #[serde(default)]
    pub links: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct AddedMagnet {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Download {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub download: String,
    #[serde(default)]
    pub generated: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Unrestricted {
    #[serde(default)]
    pub download: String,
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

    pub async fn list_torrents(&self, api_key: &str, offset: u32, page: u32, limit: u32) -> Result<Vec<Torrent>> {
        let data = self.get(api_key, "torrents", &paging(offset, page, limit, true)).await?;
        parse_list(data)
    }

    pub async fn torrent_info(&self, api_key: &str, id: &str) -> Result<Torrent> {
        let data = self.get(api_key, &format!("torrents/info/{id}"), &[]).await?;
        parse_or_default(data)
    }

    pub async fn add_magnet(&self, api_key: &str, magnet: &str, ip: Option<&str>) -> Result<AddedMagnet> {
        let form = with_ip(vec![("magnet", magnet.to_owned())], ip);
        let data = self.post(api_key, "torrents/addMagnet", form).await?;
        parse_or_default(data)
    }

    pub async fn select_files(&self, api_key: &str, id: &str, files: &str, ip: Option<&str>) -> Result<()> {
        let form = with_ip(vec![("files", files.to_owned()), ("check_cache", "1".to_owned())], ip);
        self.post(api_key, &format!("torrents/selectFiles/{id}"), form).await.map(drop)
    }

    pub async fn unrestrict_link(&self, api_key: &str, link: Option<&str>, ip: Option<&str>) -> Result<Unrestricted> {
        let mut form: Vec<(&str, String)> = link.map(|link| ("link", link.to_owned())).into_iter().collect();
        form.push(("remote", "0".to_owned()));
        let data = self.post(api_key, "unrestrict/link", with_ip(form, ip)).await?;
        parse_or_default(data)
    }

    pub async fn list_downloads(&self, api_key: &str, offset: u32, page: u32, limit: u32) -> Result<Vec<Download>> {
        let data = self.get(api_key, "downloads", &paging(offset, page, limit, false)).await?;
        parse_list(data)
    }

    async fn get(&self, api_key: &str, path: &str, query: &[(&str, String)]) -> Result<Value> {
        let request = self.http.request(Method::GET, &format!("{}/{path}", self.base_url)).query(query);
        self.send(api_key, request).await
    }

    async fn post(&self, api_key: &str, path: &str, form: Vec<(&str, String)>) -> Result<Value> {
        let request = self.http.request(Method::POST, &format!("{}/{path}", self.base_url)).form(&form);
        self.send(api_key, request).await
    }

    async fn send(&self, api_key: &str, request: reqwest::RequestBuilder) -> Result<Value> {
        let reply = self.http.send_json(request.bearer_auth(api_key)).await?;
        if reply.is_success() {
            return Ok(reply.into_data());
        }
        Err(match reply.data {
            Some(body) => Error::api(Some(reply.status), body),
            None => Error::Other(reply.request_failed_message()),
        })
    }
}

pub fn error_code(error: &Error) -> Option<i64> {
    let body = error.body()?;
    body.get("error_code").and_then(Value::as_i64)
}

pub fn error_description(code: i64) -> Option<&'static str> {
    Some(match code {
        -1 => "Internal error",
        1 => "Missing parameter",
        2 => "Bad parameter value",
        3 => "Unknown method",
        4 => "Method not allowed",
        5 => "Slow down",
        6 => "Ressource unreachable",
        7 => "Resource not found",
        8 => "Bad token",
        9 => "Permission denied",
        10 => "Two-Factor authentication needed",
        11 => "Two-Factor authentication pending",
        12 => "Invalid login",
        13 => "Invalid password",
        14 => "Account locked",
        15 => "Account not activated",
        16 => "Unsupported hoster",
        17 => "Hoster in maintenance",
        18 => "Hoster limit reached",
        19 => "Hoster temporarily unavailable",
        20 => "Hoster not available for free users",
        21 => "Too many active downloads",
        22 => "IP Address not allowed",
        23 => "Traffic exhausted",
        24 => "File unavailable",
        25 => "Service unavailable",
        26 => "Upload too big",
        27 => "Upload error",
        28 => "File not allowed",
        29 => "Torrent too big",
        30 => "Torrent file invalid",
        31 => "Action already done",
        32 => "Image resolution error",
        33 => "Torrent already active",
        34 => "Too many requests",
        35 => "Infringing file",
        _ => return None,
    })
}

fn paging(offset: u32, page: u32, limit: u32, filter: bool) -> Vec<(&'static str, String)> {
    let mut query = vec![("offset", offset.to_string()), ("page", page.to_string()), ("limit", limit.to_string())];
    if filter {
        query.push(("filter", String::new()));
    }
    query
}

fn with_ip<'a>(mut form: Vec<(&'a str, String)>, ip: Option<&str>) -> Vec<(&'a str, String)> {
    if let Some(ip) = ip.filter(|ip| !ip.is_empty()) {
        form.push(("ip", ip.to_owned()));
    }
    form
}

fn parse_list<T: serde::de::DeserializeOwned>(data: Value) -> Result<Vec<T>> {
    if !data.is_array() {
        return Ok(Vec::new());
    }
    serde_json::from_value(data).map_err(|error| Error::Other(error.to_string()))
}

fn flexible_bool<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<bool, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::Bool(value) => value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(text) => !text.is_empty() && text != "0",
        _ => false,
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

    const KEY: &str = "token";

    async fn setup() -> (MockServer, Client) {
        let server = MockServer::start().await;
        let http = Http::new(Duration::from_secs(5)).expect("http client");
        let client = Client::with_base_url(http, server.uri());
        (server, client)
    }

    #[tokio::test]
    async fn lists_torrents_with_paging_and_empty_filter() {
        let (server, client) = setup().await;
        Mock::given(method("GET"))
            .and(path("/torrents"))
            .and(header("authorization", "Bearer token"))
            .and(query_param("offset", "0"))
            .and(query_param("page", "1"))
            .and(query_param("limit", "20"))
            .and(query_param("filter", ""))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                { "id": "A1", "filename": "Movie", "hash": "ABC", "status": "downloaded", "links": ["l1"] }
            ])))
            .expect(1)
            .mount(&server)
            .await;
        let torrents = client.list_torrents(KEY, 0, 1, 20).await.expect("list");
        assert_eq!(torrents.len(), 1);
        assert_eq!(torrents[0].id, "A1");
        assert_eq!(torrents[0].status, "downloaded");
        assert_eq!(torrents[0].links, vec!["l1".to_owned()]);
    }

    #[tokio::test]
    async fn empty_torrent_list_body_is_empty_vec() {
        let (server, client) = setup().await;
        Mock::given(method("GET")).and(path("/torrents")).respond_with(ResponseTemplate::new(204)).mount(&server).await;
        assert!(client.list_torrents(KEY, 0, 1, 20).await.expect("list").is_empty());
    }

    #[tokio::test]
    async fn parses_torrent_info_with_numeric_selected_flags() {
        let (server, client) = setup().await;
        Mock::given(method("GET"))
            .and(path("/torrents/info/A1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "A1", "hash": "abc", "status": "waiting_files_selection", "added": "2020-01-01T00:00:00.000Z",
                "files": [
                    { "id": 1, "path": "/a.mkv", "bytes": 10, "selected": 1 },
                    { "id": 2, "path": "/b.nfo", "bytes": 1, "selected": 0 }
                ],
                "links": []
            })))
            .mount(&server)
            .await;
        let torrent = client.torrent_info(KEY, "A1").await.expect("info");
        assert_eq!(torrent.files.len(), 2);
        assert!(torrent.files[0].selected);
        assert!(!torrent.files[1].selected);
    }

    #[tokio::test]
    async fn adds_magnet_with_ip_as_form() {
        let (server, client) = setup().await;
        Mock::given(method("POST"))
            .and(path("/torrents/addMagnet"))
            .and(header("authorization", "Bearer token"))
            .and(body_string("magnet=magnet%3A%3Fxt%3Dabc&ip=1.2.3.4"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({ "id": "NEW1", "uri": "u" })))
            .expect(1)
            .mount(&server)
            .await;
        let added = client.add_magnet(KEY, "magnet:?xt=abc", Some("1.2.3.4")).await.expect("add");
        assert_eq!(added.id.as_deref(), Some("NEW1"));
    }

    #[tokio::test]
    async fn adds_magnet_without_ip_omits_field() {
        let (server, client) = setup().await;
        Mock::given(method("POST"))
            .and(path("/torrents/addMagnet"))
            .and(body_string("magnet=m"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({ "id": "NEW1" })))
            .expect(1)
            .mount(&server)
            .await;
        client.add_magnet(KEY, "m", None).await.expect("add");
    }

    #[tokio::test]
    async fn selects_files_with_cache_check() {
        let (server, client) = setup().await;
        Mock::given(method("POST"))
            .and(path("/torrents/selectFiles/A1"))
            .and(body_string("files=1%2C3&check_cache=1&ip=9.9.9.9"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        client.select_files(KEY, "A1", "1,3", Some("9.9.9.9")).await.expect("select");
    }

    #[tokio::test]
    async fn unrestricts_link_with_remote_flag() {
        let (server, client) = setup().await;
        Mock::given(method("POST"))
            .and(path("/unrestrict/link"))
            .and(body_string("link=https%3A%2F%2Frd%2Fx&remote=0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "download": "https://dl/x.mkv" })))
            .expect(1)
            .mount(&server)
            .await;
        let unrestricted = client.unrestrict_link(KEY, Some("https://rd/x"), None).await.expect("unrestrict");
        assert_eq!(unrestricted.download, "https://dl/x.mkv");
    }

    #[tokio::test]
    async fn lists_downloads_without_filter() {
        let (server, client) = setup().await;
        Mock::given(method("GET"))
            .and(path("/downloads"))
            .and(query_param("offset", "0"))
            .and(query_param("page", "1"))
            .and(query_param("limit", "50"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                { "id": "D1", "filename": "f.mkv", "download": "https://dl/f", "generated": "2020-01-01T00:00:00.000Z" }
            ])))
            .expect(1)
            .mount(&server)
            .await;
        let downloads = client.list_downloads(KEY, 0, 1, 50).await.expect("downloads");
        assert_eq!(downloads[0].download, "https://dl/f");
    }

    #[tokio::test]
    async fn api_errors_carry_status_and_error_code() {
        let (server, client) = setup().await;
        Mock::given(method("GET"))
            .and(path("/torrents/info/gone"))
            .respond_with(
                ResponseTemplate::new(404).set_body_json(json!({ "error": "unknown_ressource", "error_code": 7 })),
            )
            .mount(&server)
            .await;
        let error = client.torrent_info(KEY, "gone").await.expect_err("not found");
        assert_eq!(error.status(), Some(404));
        assert_eq!(error_code(&error), Some(7));
    }

    #[tokio::test]
    async fn non_json_error_body_is_reported_as_invalid_response() {
        let (server, client) = setup().await;
        Mock::given(method("GET"))
            .and(path("/torrents/info/x"))
            .respond_with(ResponseTemplate::new(502).set_body_string("<html>bad gateway</html>"))
            .mount(&server)
            .await;
        let error = client.torrent_info(KEY, "x").await.expect_err("invalid");
        assert!(error.to_string().starts_with("Invalid response (502)"));
    }

    #[test]
    fn describes_known_error_codes_only() {
        assert_eq!(error_description(8), Some("Bad token"));
        assert_eq!(error_description(999), None);
    }
}
