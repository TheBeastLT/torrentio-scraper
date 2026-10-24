use std::{sync::Arc, time::Instant};

use axum::{
    Router,
    body::Body,
    extract::{Path, Request, State},
    http::{HeaderValue, Method, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use axum_extra::{
    TypedHeader,
    headers::{Authorization, authorization::Basic},
};
use serde::Serialize;
use tower::Layer;
use tower_http::{
    cors::{AllowHeaders, Any, CorsLayer},
    normalize_path::{NormalizePath, NormalizePathLayer},
};
use url::form_urlencoded;

use crate::{
    application::{CatalogResponse, Catalogs, Extra, HandlerError},
    domain::manifest,
    infrastructure::metrics::Metrics,
};

const HANDLER_ERROR: &str = "{\"err\":\"handler error\"}";
const JSON_CONTENT_TYPE: &str = "application/json; charset=utf-8";
const CATALOG: &str = "catalog";

pub struct AppState {
    pub catalogs: Catalogs,
    pub metrics: Metrics,
    pub metrics_credentials: Option<(String, String)>,
}

pub fn app(state: Arc<AppState>) -> NormalizePath<Router> {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::HEAD, Method::PUT, Method::PATCH, Method::POST, Method::DELETE])
        .allow_headers(AllowHeaders::mirror_request());
    let dynamic = Router::new()
        .route("/manifest.json", get(manifest_response))
        .route("/{configuration}/manifest.json", get(manifest_configured))
        .route("/{first}/{second}/{third}", get(catalog_short))
        .route("/{first}/{second}/{third}/{fourth}", get(catalog_medium))
        .route("/{first}/{second}/{third}/{fourth}/{fifth}", get(catalog_long))
        .layer(cors)
        .layer(middleware::from_fn_with_state(Arc::clone(&state), record_metrics))
        .with_state(Arc::clone(&state));
    let router = Router::new().route("/metrics", get(metrics_handler)).fallback_service(dynamic).with_state(state);
    NormalizePathLayer::trim_trailing_slash().layer(router)
}

async fn metrics_handler(
    State(state): State<Arc<AppState>>,
    credentials: Option<TypedHeader<Authorization<Basic>>>,
) -> Response {
    let authorized = matches!(
        (&state.metrics_credentials, credentials),
        (Some((user, password)), Some(TypedHeader(basic))) if basic.username() == user && basic.password() == password
    );
    if !authorized {
        return (StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, "Basic realm=\"metrics\"")], "Unauthorized")
            .into_response();
    }
    let (size, idle) = state.catalogs.repository().pool_stats();
    state.metrics.pool(size, idle);
    state.metrics.observe_runtime();
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")], state.metrics.render()).into_response()
}

async fn record_metrics(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    let resource = resource_label(request.uri().path());
    let started = Instant::now();
    let response = next.run(request).await;
    state.metrics.http_request(resource, response.status().as_u16(), started.elapsed());
    response
}

fn resource_label(path: &str) -> &'static str {
    if path.ends_with("/manifest.json") {
        "manifest"
    } else if path.split('/').any(|segment| segment == CATALOG) {
        CATALOG
    } else {
        "other"
    }
}

fn json_response<T: Serialize>(body: &T, cache_control: Option<String>) -> Response {
    match serde_json::to_vec(body) {
        Ok(bytes) => {
            let mut response = Response::new(Body::from(bytes));
            response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(JSON_CONTENT_TYPE));
            if let Some(value) = cache_control.and_then(|value| HeaderValue::from_str(&value).ok()) {
                response.headers_mut().insert(header::CACHE_CONTROL, value);
            }
            response
        }
        Err(error) => {
            tracing::error!(%error, "Failed serializing response");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn manifest_response() -> Response {
    json_response(&manifest(), None)
}

async fn manifest_configured(Path(_configuration): Path<String>) -> Response {
    manifest_response().await
}

fn json_name(segment: &str) -> Option<&str> {
    segment.strip_suffix(".json").filter(|name| !name.is_empty())
}

struct Target<'a> {
    id: &'a str,
    extra: Option<&'a str>,
}

async fn catalog_short(
    State(state): State<Arc<AppState>>,
    Path((resource, _kind, id)): Path<(String, String, String)>,
) -> Response {
    match (resource == CATALOG).then(|| json_name(&id)).flatten() {
        Some(id) => catalog_response(&state, &Target { id, extra: None }).await,
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn catalog_medium(
    State(state): State<Arc<AppState>>,
    uri: Uri,
    Path((first, second, third, fourth)): Path<(String, String, String, String)>,
) -> Response {
    let target = if first == CATALOG {
        json_name(&fourth).and(Some(Target { id: &third, extra: raw_extra(&uri) }))
    } else if second == CATALOG {
        json_name(&fourth).map(|id| Target { id, extra: None })
    } else {
        None
    };
    match target {
        Some(target) => catalog_response(&state, &target).await,
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn catalog_long(
    State(state): State<Arc<AppState>>,
    uri: Uri,
    Path((_configuration, resource, _kind, id, extra)): Path<(String, String, String, String, String)>,
) -> Response {
    if resource != CATALOG || json_name(&extra).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    catalog_response(&state, &Target { id: &id, extra: raw_extra(&uri) }).await
}

fn raw_extra(uri: &Uri) -> Option<&str> {
    uri.path().rsplit('/').next().and_then(json_name)
}

fn parse_extra(raw: Option<&str>) -> Extra {
    let mut extra = Extra::default();
    for (key, value) in form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
        match key.as_ref() {
            "genre" if extra.genre.is_none() => extra.genre = Some(value.into_owned()),
            "skip" if extra.skip.is_none() => extra.skip = Some(value.into_owned()),
            _ => {}
        }
    }
    extra
}

fn cache_control(response: &CatalogResponse) -> String {
    let directives: Vec<String> = [
        Some(format!("max-age={}", response.cache_max_age)),
        response.stale_revalidate.map(|age| format!("stale-while-revalidate={age}")),
        response.stale_error.map(|age| format!("stale-if-error={age}")),
    ]
    .into_iter()
    .flatten()
    .collect();
    format!("{}, public", directives.join(", "))
}

async fn catalog_response(state: &AppState, target: &Target<'_>) -> Response {
    match state.catalogs.catalog(target.id, &parse_extra(target.extra)).await {
        Ok(response) => json_response(&response, Some(cache_control(&response))),
        Err(error @ HandlerError::UnknownCatalog(_)) => {
            tracing::error!("{error}");
            let mut response = Response::new(Body::from(HANDLER_ERROR));
            *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
            response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(JSON_CONTENT_TYPE));
            response
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt as _;

    use super::*;
    use crate::application::testing::{FakeIds, fixture_catalogs};

    fn test_app() -> NormalizePath<Router> {
        let metrics = Metrics::new();
        let catalogs = fixture_catalogs(Arc::new(FakeIds::with_count(45)), metrics.clone());
        app(Arc::new(AppState {
            catalogs,
            metrics,
            metrics_credentials: Some(("user".to_owned(), "secret".to_owned())),
        }))
    }

    async fn call(method: Method, path: &str) -> Response {
        let request = HttpRequest::builder().method(method).uri(path).body(Body::empty()).unwrap();
        test_app().oneshot(request).await.unwrap()
    }

    async fn body(response: Response) -> String {
        String::from_utf8(axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap().to_vec()).unwrap()
    }

    #[tokio::test]
    async fn serves_the_manifest_for_get_and_head() {
        for method in [Method::GET, Method::HEAD] {
            let response = call(method, "/manifest.json").await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], JSON_CONTENT_TYPE);
        }
    }

    #[tokio::test]
    async fn serves_the_same_manifest_under_a_configuration_prefix() {
        let plain = body(call(Method::GET, "/manifest.json").await).await;
        let configured = body(call(Method::GET, "/lite/manifest.json").await).await;
        assert_eq!(plain, configured);
    }

    #[tokio::test]
    async fn serves_catalogs_with_cache_headers() {
        let response = call(Method::GET, "/catalog/movie/top-movies.json").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "max-age=14400, stale-while-revalidate=14400, stale-if-error=604800, public"
        );
        let json: serde_json::Value = serde_json::from_str(&body(response).await).unwrap();
        assert_eq!(json["metas"].as_array().unwrap().len(), 20);
        assert_eq!(json["cacheMaxAge"], 14400);
    }

    #[tokio::test]
    async fn catalog_type_segment_is_ignored() {
        let response = call(Method::GET, "/catalog/anything/top-series.json").await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn parses_extra_into_genre_and_skip() {
        let response = call(Method::GET, "/catalog/movie/top-movies/genre=This%20Week&skip=0.json").await;
        assert_eq!(response.status(), StatusCode::OK);
        let response = call(Method::GET, "/catalog/movie/top-movies/skip=20.json").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "max-age=1800, public");
        assert_eq!(body(response).await, r#"{"metas":[],"cacheMaxAge":1800}"#);
    }

    #[tokio::test]
    async fn configuration_prefixed_catalogs_work_with_and_without_extra() {
        assert_eq!(call(Method::GET, "/lite/catalog/movie/top-movies.json").await.status(), StatusCode::OK);
        let response = call(Method::GET, "/lite/catalog/movie/top-movies/genre=Yesterday.json").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    }

    #[tokio::test]
    async fn unknown_catalogs_are_a_handler_error() {
        let response = call(Method::GET, "/catalog/movie/top-tv.json").await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(response.headers()[header::CONTENT_TYPE], JSON_CONTENT_TYPE);
        assert_eq!(body(response).await, HANDLER_ERROR);
    }

    #[tokio::test]
    async fn other_resources_and_malformed_paths_are_not_found() {
        for path in [
            "/",
            "/configure",
            "/stream/movie/tt1.json",
            "/lite/stream/movie/tt1.json",
            "/catalog/movie/top-movies",
            "/catalog/movie/.json",
            "/catalog/movie/top-movies/genre=Yesterday",
            "/lite/catalog/movie/top-movies/genre=Yesterday",
            "/a/b/c/d/e/f/g.json",
        ] {
            assert_eq!(call(Method::GET, path).await.status(), StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[tokio::test]
    async fn tolerates_a_trailing_slash() {
        assert_eq!(call(Method::GET, "/manifest.json/").await.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn adds_cors_to_every_dynamic_response() {
        for path in ["/manifest.json", "/catalog/movie/top-movies.json", "/missing/path/here"] {
            let response = call(Method::GET, path).await;
            assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*", "{path}");
        }
    }

    #[tokio::test]
    async fn answers_preflight_requests() {
        let request = HttpRequest::builder()
            .method(Method::OPTIONS)
            .uri("/catalog/movie/top-movies.json")
            .header(header::ORIGIN, "https://web.stremio.com")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
            .body(Body::empty())
            .unwrap();
        let response = test_app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    }

    #[tokio::test]
    async fn metrics_require_credentials() {
        assert_eq!(call(Method::GET, "/metrics").await.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn metrics_render_with_valid_credentials() {
        let request = HttpRequest::builder()
            .uri("/metrics")
            .header(header::AUTHORIZATION, "Basic dXNlcjpzZWNyZXQ=")
            .body(Body::empty())
            .unwrap();
        let response = test_app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
        assert!(body(response).await.contains("db_pool_connections"));
    }

    #[test]
    fn extra_keeps_the_first_value_of_repeated_keys() {
        let extra = parse_extra(Some("genre=Last+Week&skip=20&skip=40&other=1"));
        assert_eq!(extra, Extra { genre: Some("Last Week".to_owned()), skip: Some("20".to_owned()) });
        assert_eq!(parse_extra(None), Extra::default());
    }

    #[test]
    fn labels_metrics_by_resource() {
        assert_eq!(resource_label("/manifest.json"), "manifest");
        assert_eq!(resource_label("/lite/manifest.json"), "manifest");
        assert_eq!(resource_label("/catalog/movie/top-movies.json"), "catalog");
        assert_eq!(resource_label("/robots.txt"), "other");
    }
}
