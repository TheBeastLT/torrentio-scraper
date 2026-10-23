use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{Error, Http, Result, util::parse_value};

const BASE_URL: &str = "https://api.put.io/v2";

#[derive(Clone, Debug, Default, Deserialize)]
pub struct File {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub file_type: String,
    #[serde(default)]
    pub created_at: String,
}

impl File {
    pub fn is_folder(&self) -> bool {
        self.file_type == "FOLDER"
    }

    pub fn is_video_type(&self) -> bool {
        self.file_type == "VIDEO"
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct FileListing {
    #[serde(default)]
    pub files: Vec<File>,
    #[serde(default)]
    pub parent: Option<File>,
}

impl FileListing {
    pub fn into_entries(self) -> Vec<File> {
        if self.files.is_empty() { self.parent.into_iter().collect() } else { self.files }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Transfer {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub hash: Option<String>,
    #[serde(default)]
    pub file_id: Option<i64>,
    #[serde(default)]
    pub userfile_exists: Option<bool>,
}

#[derive(Deserialize)]
struct Transfers {
    #[serde(default)]
    transfers: Vec<Transfer>,
}

#[derive(Deserialize)]
struct TransferEnvelope {
    #[serde(default)]
    transfer: Option<Transfer>,
}

#[derive(Deserialize)]
struct StorageUrl {
    #[serde(default)]
    url: Option<String>,
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

    pub async fn list_files(&self, token: &str, parent_id: &str) -> Result<FileListing> {
        let value = self.request(token, Method::GET, "/files/list", &[("parent_id", parent_id)], None).await?;
        parse_value(value)
    }

    pub async fn list_transfers(&self, token: &str) -> Result<Vec<Transfer>> {
        let value = self.request(token, Method::GET, "/transfers/list", &[], None).await?;
        Ok(parse_value::<Transfers>(value)?.transfers)
    }

    pub async fn get_transfer(&self, token: &str, id: i64) -> Result<Transfer> {
        let value = self.request(token, Method::GET, &format!("/transfers/{id}"), &[], None).await?;
        transfer(value)
    }

    pub async fn add_transfer(&self, token: &str, url: &str) -> Result<Transfer> {
        let value = self.request(token, Method::POST, "/transfers/add", &[], Some(json!({ "url": url }))).await?;
        transfer(value)
    }

    pub async fn cancel_transfers(&self, token: &str, ids: &[i64]) -> Result<()> {
        let ids = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
        self.request(token, Method::POST, "/transfers/cancel", &[], Some(json!({ "transfer_ids": ids })))
            .await
            .map(drop)
    }

    pub async fn storage_url(&self, token: &str, file_id: i64) -> Result<Option<String>> {
        let value = self.request(token, Method::GET, &format!("/files/{file_id}/url"), &[], None).await?;
        Ok(parse_value::<StorageUrl>(value)?.url)
    }

    async fn request(
        &self,
        token: &str,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value> {
        let mut request = self
            .http
            .request(method, &format!("{}{}", self.base_url, path))
            .header("Authorization", format!("token {token}"));
        if !query.is_empty() {
            request = request.query(query);
        }
        if let Some(body) = &body {
            request = request.json(body);
        }
        let response = request.send().await?;
        let status = response.status();
        let text = response.text().await?;
        if status.is_success() {
            return serde_json::from_str(&text).map_err(|error| Error::Other(error.to_string()));
        }
        let mut error = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({ "error_message": text }));
        if let Some(object) = error.as_object_mut() {
            object.insert("status_code".to_owned(), json!(status.as_u16()));
        }
        Err(Error::api(Some(status.as_u16()), error))
    }
}

fn transfer(value: Value) -> Result<Transfer> {
    parse_value::<TransferEnvelope>(value)?
        .transfer
        .ok_or_else(|| Error::Other("Missing transfer in response".to_owned()))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_json, header, method, path, query_param},
    };

    use super::*;

    async fn setup() -> (MockServer, Client) {
        let server = MockServer::start().await;
        let http = Http::new(Duration::from_secs(5)).expect("http client");
        let client = Client::with_base_url(http, server.uri());
        (server, client)
    }

    #[tokio::test]
    async fn lists_files_with_token_header_and_parent_query() {
        let (server, client) = setup().await;
        Mock::given(method("GET"))
            .and(path("/files/list"))
            .and(query_param("parent_id", "12"))
            .and(header("Authorization", "token secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "OK",
                "files": [{ "id": 5, "name": "a.mkv", "size": 10, "file_type": "VIDEO", "created_at": "2024-01-01T10:00:00" }],
                "parent": { "id": 12, "name": "dir", "file_type": "FOLDER" }
            })))
            .mount(&server)
            .await;
        let listing = client.list_files("secret", "12").await.expect("listing");
        assert_eq!(listing.files.len(), 1);
        assert_eq!(listing.files[0].id, 5);
        assert!(listing.files[0].is_video_type());
        assert!(listing.parent.is_some_and(|parent| parent.is_folder()));
    }

    #[tokio::test]
    async fn empty_listing_falls_back_to_parent() {
        let listing = FileListing { files: Vec::new(), parent: Some(File { id: 3, ..File::default() }) };
        let entries = listing.into_entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, 3);
    }

    #[tokio::test]
    async fn empty_listing_without_parent_has_no_entries() {
        assert!(FileListing::default().into_entries().is_empty());
    }

    #[tokio::test]
    async fn lists_transfers() {
        let (server, client) = setup().await;
        Mock::given(method("GET"))
            .and(path("/transfers/list"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "transfers": [{ "id": 1, "status": "SEEDING", "source": "magnet:?xt=urn:btih:abc", "file_id": 77, "userfile_exists": true }]
            })))
            .mount(&server)
            .await;
        let transfers = client.list_transfers("secret").await.expect("transfers");
        assert_eq!(transfers.len(), 1);
        assert_eq!(transfers[0].file_id, Some(77));
        assert_eq!(transfers[0].userfile_exists, Some(true));
    }

    #[tokio::test]
    async fn gets_transfer_by_id() {
        let (server, client) = setup().await;
        Mock::given(method("GET"))
            .and(path("/transfers/9"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "transfer": { "id": 9, "status": "COMPLETED" } })),
            )
            .mount(&server)
            .await;
        let transfer = client.get_transfer("secret", 9).await.expect("transfer");
        assert_eq!(transfer.status, "COMPLETED");
    }

    #[tokio::test]
    async fn adds_transfer_with_json_body() {
        let (server, client) = setup().await;
        Mock::given(method("POST"))
            .and(path("/transfers/add"))
            .and(body_json(json!({ "url": "magnet:?xt=urn:btih:abc" })))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "transfer": { "id": 4, "status": "WAITING" } })),
            )
            .mount(&server)
            .await;
        let transfer = client.add_transfer("secret", "magnet:?xt=urn:btih:abc").await.expect("transfer");
        assert_eq!(transfer.id, 4);
    }

    #[tokio::test]
    async fn cancels_transfers_with_comma_joined_ids() {
        let (server, client) = setup().await;
        Mock::given(method("POST"))
            .and(path("/transfers/cancel"))
            .and(body_json(json!({ "transfer_ids": "1,2" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "status": "OK" })))
            .expect(1)
            .mount(&server)
            .await;
        client.cancel_transfers("secret", &[1, 2]).await.expect("cancel");
    }

    #[tokio::test]
    async fn fetches_storage_url() {
        let (server, client) = setup().await;
        Mock::given(method("GET"))
            .and(path("/files/5/url"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "url": "https://cdn.put.io/f" })))
            .mount(&server)
            .await;
        assert_eq!(client.storage_url("secret", 5).await.expect("url").as_deref(), Some("https://cdn.put.io/f"));
    }

    #[tokio::test]
    async fn api_errors_carry_body_and_status_code() {
        let (server, client) = setup().await;
        Mock::given(method("GET"))
            .and(path("/transfers/list"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                "error_type": "invalid_grant",
                "error_message": "Invalid token"
            })))
            .mount(&server)
            .await;
        let error = client.list_transfers("secret").await.expect_err("error");
        assert_eq!(error.status(), Some(401));
        let body = error.body().expect("body");
        assert_eq!(body["error_type"], "invalid_grant");
        assert_eq!(body["status_code"], 401);
    }

    #[tokio::test]
    async fn non_json_error_bodies_become_error_messages() {
        let (server, client) = setup().await;
        Mock::given(method("GET"))
            .and(path("/transfers/list"))
            .respond_with(ResponseTemplate::new(502).set_body_string("bad gateway"))
            .mount(&server)
            .await;
        let error = client.list_transfers("secret").await.expect_err("error");
        assert_eq!(error.status(), Some(502));
        assert_eq!(error.body().expect("body")["error_message"], "bad gateway");
    }
}
