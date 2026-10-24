use std::time::{Duration, Instant};

use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value;

use crate::{
    domain::{ContentType, MetadataSource, SourceError},
    infrastructure::metrics::Metrics,
};

pub const CINEMETA_URL: &str = "https://v3-cinemeta.strem.io";
pub const KITSU_URL: &str = "https://anime-kitsu.strem.fun";
pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(10_000);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SIZE: usize = 40;
const STRIPPED_FIELDS: [&str; 3] = ["videos", "credits_cast", "credits_crew"];

pub struct Metadata {
    http: Client,
    cinemeta_url: String,
    kitsu_url: String,
    timeout: Duration,
    metrics: Metrics,
}

impl Metadata {
    pub fn new(
        cinemeta_url: &str,
        kitsu_url: &str,
        timeout: Duration,
        metrics: Metrics,
    ) -> Result<Self, reqwest::Error> {
        let http = Client::builder()
            .timeout(timeout)
            .connect_timeout(CONNECT_TIMEOUT)
            .pool_idle_timeout(POOL_IDLE_TIMEOUT)
            .build()?;
        Ok(Self {
            http,
            cinemeta_url: cinemeta_url.trim_end_matches('/').to_owned(),
            kitsu_url: kitsu_url.trim_end_matches('/').to_owned(),
            timeout,
            metrics,
        })
    }

    fn url(&self, ids: &[String], kind: ContentType) -> String {
        let page = &ids[..ids.len().min(MAX_SIZE)];
        if kind == ContentType::Anime {
            let joined: Vec<String> = page.iter().map(|id| format!("kitsu:{id}")).collect();
            format!(
                "{}/catalog/{}/kitsu-anime-list/lastVideosIds={}.json",
                self.kitsu_url,
                kind.as_str(),
                joined.join(",")
            )
        } else {
            format!("{}/catalog/{}/last-videos/lastVideosIds={}.json", self.cinemeta_url, kind.as_str(), page.join(","))
        }
    }

    async fn request(&self, url: &str) -> Result<Vec<Value>, Failure> {
        let response = self.http.get(url).send().await.map_err(|error| self.describe(&error))?;
        let status = response.status();
        if !status.is_success() {
            return Err(Failure::Error(format!("Request failed with status code {}", status.as_u16())));
        }
        let mut body: Value = response.json().await.map_err(|error| self.describe(&error))?;
        let metas = ["metas", "metasDetailed"]
            .into_iter()
            .find_map(|field| match body.get_mut(field).map(Value::take) {
                Some(Value::Array(metas)) => Some(metas),
                _ => None,
            })
            .unwrap_or_default();
        Ok(metas.into_iter().filter(|meta| !meta.is_null()).map(sanitize).collect())
    }

    fn describe(&self, error: &reqwest::Error) -> Failure {
        if error.is_timeout() {
            Failure::Timeout(format!("timeout of {}ms exceeded", self.timeout.as_millis()))
        } else {
            Failure::Error(error.to_string())
        }
    }
}

enum Failure {
    Timeout(String),
    Error(String),
}

fn sanitize(mut meta: Value) -> Value {
    if let Some(object) = meta.as_object_mut() {
        for field in STRIPPED_FIELDS {
            object.shift_remove(field);
        }
    }
    meta
}

#[async_trait]
impl MetadataSource for Metadata {
    async fn metas(&self, ids: &[String], kind: ContentType) -> Result<Vec<Value>, SourceError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let source = if kind == ContentType::Anime { "kitsu" } else { "cinemeta" };
        let started = Instant::now();
        let result = self.request(&self.url(ids, kind)).await;
        let outcome = match &result {
            Ok(_) => "ok",
            Err(Failure::Timeout(_)) => "timeout",
            Err(Failure::Error(_)) => "error",
        };
        self.metrics.metadata_request(source, outcome, started.elapsed());
        result.map_err(|(Failure::Timeout(message) | Failure::Error(message))| {
            SourceError(format!("failed metadata {} query due: {message}", kind.as_str()))
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{method, path},
    };

    use super::*;

    fn client(server: &MockServer, timeout: Duration) -> Metadata {
        Metadata::new(&server.uri(), &server.uri(), timeout, Metrics::new()).unwrap()
    }

    fn recorded(metadata: &Metadata, source: &str, outcome: &str) -> bool {
        let series = format!(r#"metadata_requests_total{{outcome="{outcome}",source="{source}","#);
        metadata.metrics.render().lines().any(|line| line.starts_with(&series) && line.ends_with(" 1"))
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|id| (*id).to_owned()).collect()
    }

    #[tokio::test]
    async fn requests_cinemeta_last_videos_and_strips_heavy_fields() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/catalog/movie/last-videos/lastVideosIds=tt1,tt2.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "metas": [
                    { "id": "tt1", "name": "One", "videos": [1], "credits_cast": [], "credits_crew": [] },
                    null,
                    { "id": "tt2", "name": "Two" }
                ]
            })))
            .mount(&server)
            .await;
        let metas = client(&server, DEFAULT_TIMEOUT).metas(&ids(&["tt1", "tt2"]), ContentType::Movie).await.unwrap();
        assert_eq!(metas, vec![json!({ "id": "tt1", "name": "One" }), json!({ "id": "tt2", "name": "Two" })]);
    }

    #[tokio::test]
    async fn requests_kitsu_ids_for_anime_and_reads_detailed_metas() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/catalog/anime/kitsu-anime-list/lastVideosIds=kitsu:5,kitsu:6.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "metasDetailed": [{ "id": "kitsu:5" }] })))
            .mount(&server)
            .await;
        let metadata = client(&server, DEFAULT_TIMEOUT);
        let metas = metadata.metas(&ids(&["5", "6"]), ContentType::Anime).await.unwrap();
        assert_eq!(metas, vec![json!({ "id": "kitsu:5" })]);
        assert!(recorded(&metadata, "kitsu", "ok"));
    }

    #[tokio::test]
    async fn requests_at_most_forty_ids() {
        let metadata = Metadata::new("http://c", "http://k", DEFAULT_TIMEOUT, Metrics::new()).unwrap();
        let many: Vec<String> = (0..100).map(|n| format!("tt{n}")).collect();
        assert_eq!(metadata.url(&many, ContentType::Series).matches(',').count(), 39);
    }

    #[tokio::test]
    async fn empty_ids_skip_the_request() {
        let metadata =
            Metadata::new("http://127.0.0.1:1", "http://127.0.0.1:1", DEFAULT_TIMEOUT, Metrics::new()).unwrap();
        assert_eq!(metadata.metas(&[], ContentType::Movie).await.unwrap(), Vec::<Value>::new());
    }

    #[tokio::test]
    async fn missing_metas_are_empty() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(&server)
            .await;
        let metas = client(&server, DEFAULT_TIMEOUT).metas(&ids(&["tt1"]), ContentType::Movie).await.unwrap();
        assert_eq!(metas, Vec::<Value>::new());
    }

    #[tokio::test]
    async fn http_failures_carry_the_status() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).respond_with(ResponseTemplate::new(503)).mount(&server).await;
        let metadata = client(&server, DEFAULT_TIMEOUT);
        let error = metadata.metas(&ids(&["tt1"]), ContentType::Series).await.unwrap_err();
        assert_eq!(error.0, "failed metadata series query due: Request failed with status code 503");
        assert!(recorded(&metadata, "cinemeta", "error"));
    }

    #[tokio::test]
    async fn slow_responses_time_out() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(500)))
            .mount(&server)
            .await;
        let metadata = client(&server, Duration::from_millis(50));
        let error = metadata.metas(&ids(&["tt1"]), ContentType::Movie).await.unwrap_err();
        assert_eq!(error.0, "failed metadata movie query due: timeout of 50ms exceeded");
        assert!(recorded(&metadata, "cinemeta", "timeout"));
    }
}
