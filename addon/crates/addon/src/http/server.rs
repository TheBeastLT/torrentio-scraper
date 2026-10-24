use std::{fmt, net::SocketAddr, path::Path as FsPath, sync::Arc, time::Instant};

use axum::{
    Router,
    body::Body,
    extract::{ConnectInfo, Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::get,
};
use axum_extra::{
    TypedHeader,
    headers::{Authorization, authorization::Basic},
};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use tower::Layer;
use tower_http::{
    compression::CompressionLayer,
    cors::{AllowHeaders, Any, CorsLayer},
    normalize_path::{NormalizePath, NormalizePathLayer},
    services::ServeDir,
    set_header::SetResponseHeaderLayer,
};
use url::form_urlencoded;

use crate::{
    application::addon::Addon,
    application::error::HandlerError,
    domain::config::{Config, RequestContext},
    domain::stream::StreamsResponse,
    http::client_ip::client_ip,
    http::landing::landing,
    http::manifest::manifest,
    infrastructure::metrics::Metrics,
    infrastructure::ratelimit::RateLimiter,
    providers::{MOCHS, ResolveParams, Resolved},
};

const RESOLVED_URL_CACHE_CONTROL: &str = "max-age=21600, public";
const STATIC_CACHE_CONTROL: &str = "public, max-age=31536000";
const RATE_LIMITED: &str = "Too many requests, please try again later.";
const HANDLER_ERROR: &str = "{\"err\":\"handler error\"}";
const KNOWN_RESOURCES: &[&str] = &["stream", "meta", "catalog"];

pub struct AppState {
    pub addon: Addon,
    pub metrics: Metrics,
    pub rate_limiter: RateLimiter,
    pub metrics_credentials: Option<(String, String)>,
}

pub fn app(state: Arc<AppState>, static_dir: &FsPath) -> NormalizePath<Router> {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::HEAD, Method::PUT, Method::PATCH, Method::POST, Method::DELETE])
        .allow_headers(AllowHeaders::mirror_request());
    let dynamic = Router::new()
        .route("/", get(|| async { Redirect::to("/configure") }))
        .route("/lite", get(|| async { Redirect::to("/lite/configure") }))
        .route("/brazuca", get(|| async { Redirect::to("/brazuca/configure") }))
        .route("/configure", get(configure_default))
        .route("/{configuration}/configure", get(configure))
        .route("/manifest.json", get(manifest_default))
        .route("/{configuration}/manifest.json", get(manifest_for))
        .route("/{resource}/{kind}/{id}", get(resource_plain))
        .route("/{configuration}/{resource}/{kind}/{id}", get(resource_configured))
        .route("/{configuration}/{resource}/{kind}/{id}/{extra}", get(resource_extra))
        .route("/resolve/{moch}/{api_key}/{info_hash}/{entry}/{index}", get(resolve))
        .route("/resolve/{moch}/{api_key}/{info_hash}/{entry}/{index}/{filename}", get(resolve_named))
        .layer(cors)
        .layer(CompressionLayer::new())
        .with_state(Arc::clone(&state));
    let mut app = Router::new().fallback_service(dynamic);
    for entry in std::fs::read_dir(static_dir).into_iter().flatten().flatten() {
        if let (true, Ok(name)) = (entry.path().is_dir(), entry.file_name().into_string()) {
            app = app.nest_service(&format!("/{name}"), static_files(&entry.path()));
        }
    }
    let app = app.layer(middleware::from_fn_with_state(Arc::clone(&state), record_metrics));
    let router = Router::new().route("/metrics", get(metrics_handler)).fallback_service(app).with_state(state);
    NormalizePathLayer::trim_trailing_slash().layer(router)
}

fn static_files(
    dir: &FsPath,
) -> impl tower::Service<Request, Response = Response, Error = std::convert::Infallible, Future: Send> + Clone + Send + 'static
{
    let not_found = get(|| async { (StatusCode::NOT_FOUND, [(header::CACHE_CONTROL, "no-cache")]) }).with_state(());
    let files = ServeDir::new(dir).append_index_html_on_directories(false).not_found_service(not_found);
    tower::ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static(STATIC_CACHE_CONTROL),
        ))
        .map_response(IntoResponse::into_response)
        .service(files)
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
    let (size, idle) = state.addon.repository().pool_stats();
    state.metrics.pool(size, idle);
    state.addon.cache().observe();
    state.metrics.observe_runtime();
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")], state.metrics.render()).into_response()
}

async fn record_metrics(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    let (resource, moch) = route_labels(request.uri().path());
    let started = Instant::now();
    let response = next.run(request).await;
    state.metrics.http_request(&resource, &moch, response.status().as_u16(), started.elapsed());
    response
}

fn route_labels(path: &str) -> (String, String) {
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.first() == Some(&"resolve") {
        return ("resolve".to_owned(), config_moch(parts.get(1).copied().unwrap_or_default()));
    }
    if let Some(index) = parts.iter().position(|part| KNOWN_RESOURCES.contains(part)) {
        let moch = index.checked_sub(1).map_or_else(|| config_moch(""), |previous| config_moch(parts[previous]));
        return (parts[index].to_owned(), moch);
    }
    if path.contains("manifest.json") {
        return ("manifest".to_owned(), "na".to_owned());
    }
    if path.contains("/configure") {
        return ("configure".to_owned(), "na".to_owned());
    }
    ("other".to_owned(), "na".to_owned())
}

fn config_moch(segment: &str) -> String {
    let decoded =
        percent_decode_str(segment).decode_utf8().map_or_else(|_| segment.to_owned(), std::borrow::Cow::into_owned);
    let mut mochs: Vec<&str> = Vec::new();
    for pair in decoded.split('|') {
        let key = pair.split('=').next().unwrap_or_default().to_lowercase();
        if let Some(info) = MOCHS.iter().find(|info| info.key == key)
            && !mochs.contains(&info.key)
        {
            mochs.push(info.key);
        }
    }
    match mochs.len() {
        1 => mochs[0].to_owned(),
        0 => "na".to_owned(),
        _ => "multiple".to_owned(),
    }
}

fn request_origin(headers: &HeaderMap) -> String {
    let protocol = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map_or("http", str::trim);
    let host = headers.get(header::HOST).and_then(|value| value.to_str().ok()).unwrap_or_default();
    format!("{protocol}://{host}")
}

fn is_browser(headers: &HeaderMap) -> bool {
    let user_agent = headers.get(header::USER_AGENT).and_then(|value| value.to_str().ok()).unwrap_or_default();
    if user_agent.contains("Stremio") {
        return false;
    }
    woothee::parser::Parser::new().parse(user_agent).is_some_and(|result| {
        matches!(result.category, "pc" | "smartphone" | "mobilephone") && result.name != "UNKNOWN"
    })
}

struct CacheControl {
    max_age: Option<u32>,
    stale_revalidate: Option<u32>,
    stale_error: Option<u32>,
}

impl CacheControl {
    fn max_age(max_age: u32) -> Self {
        Self { max_age: Some(max_age), stale_revalidate: None, stale_error: None }
    }
}

impl From<&StreamsResponse> for CacheControl {
    fn from(response: &StreamsResponse) -> Self {
        Self {
            max_age: response.cache_max_age,
            stale_revalidate: response.stale_revalidate,
            stale_error: response.stale_error,
        }
    }
}

impl fmt::Display for CacheControl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let directives: Vec<String> = [
            self.max_age.map(|age| format!("max-age={age}")),
            self.stale_revalidate.map(|age| format!("stale-while-revalidate={age}")),
            self.stale_error.map(|age| format!("stale-if-error={age}")),
        ]
        .into_iter()
        .flatten()
        .collect();
        write!(formatter, "{}, public", directives.join(", "))
    }
}

fn json_response<T: Serialize>(body: &T, cache: Option<CacheControl>) -> Response {
    match serde_json::to_vec(body) {
        Ok(bytes) => {
            let mut response = Response::new(Body::from(bytes));
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
            if let Some(value) = cache.and_then(|cache| HeaderValue::from_str(&cache.to_string()).ok()) {
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

fn configured(configuration: &str, origin: String) -> Config {
    Config::parse(configuration).with_host(origin)
}

async fn configure_default(headers: HeaderMap) -> Response {
    configure_page("", &headers)
}

async fn configure(Path(configuration): Path<String>, headers: HeaderMap) -> Response {
    configure_page(&configuration, &headers)
}

fn configure_page(configuration: &str, headers: &HeaderMap) -> Response {
    let config = configured(configuration, request_origin(headers));
    ([(header::CONTENT_TYPE, "text/html")], landing(&manifest(&config), &config)).into_response()
}

async fn manifest_default(headers: HeaderMap) -> Response {
    manifest_response("", &headers)
}

async fn manifest_for(Path(configuration): Path<String>, headers: HeaderMap) -> Response {
    manifest_response(&configuration, &headers)
}

fn manifest_response(configuration: &str, headers: &HeaderMap) -> Response {
    json_response(&manifest(&configured(configuration, request_origin(headers))), None)
}

fn json_name(segment: &str) -> Option<&str> {
    segment.strip_suffix(".json").filter(|name| !name.is_empty())
}

struct Resource<'a> {
    configuration: &'a str,
    name: &'a str,
    kind: &'a str,
    id: &'a str,
    extra: Option<&'a str>,
}

async fn resource_plain(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    Path((resource, kind, id)): Path<(String, String, String)>,
) -> Response {
    let Some(id) = json_name(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let target = Resource { configuration: "", name: &resource, kind: &kind, id, extra: None };
    resource_response(&state, peer, &headers, &uri, &target).await
}

async fn resource_configured(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    Path((configuration, resource, kind, id)): Path<(String, String, String, String)>,
) -> Response {
    let Some(id) = json_name(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let target = Resource { configuration: &configuration, name: &resource, kind: &kind, id, extra: None };
    resource_response(&state, peer, &headers, &uri, &target).await
}

async fn resource_extra(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    Path((configuration, resource, kind, id, extra)): Path<(String, String, String, String, String)>,
) -> Response {
    if json_name(&extra).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let raw = uri.path().rsplit('/').next().and_then(json_name);
    let target = Resource { configuration: &configuration, name: &resource, kind: &kind, id: &id, extra: raw };
    resource_response(&state, peer, &headers, &uri, &target).await
}

async fn resource_response(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    _uri: &Uri,
    target: &Resource<'_>,
) -> Response {
    let ip = client_ip(headers, Some(peer));
    if !state.rate_limiter.allow(ip.as_deref().unwrap_or_default()) {
        return (StatusCode::TOO_MANY_REQUESTS, RATE_LIMITED).into_response();
    }
    let extra_values = target
        .extra
        .map(|query| {
            form_urlencoded::parse(query.as_bytes())
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect()
        })
        .unwrap_or_default();
    let config = Config::parse(target.configuration).with_request(RequestContext {
        ip,
        host: request_origin(headers),
        extra: extra_values,
    });
    let (id, kind) = (target.id, target.kind);
    let (outcome, failure) = match target.name {
        "stream" => (
            state
                .addon
                .streams(kind, id, &config)
                .await
                .map(|response| json_response(&response, Some((&response).into()))),
            format!("Failed request {id}"),
        ),
        "catalog" => (
            state
                .addon
                .catalog(id, &config)
                .await
                .map(|response| json_response(&response, Some(CacheControl::max_age(response.cache_max_age)))),
            format!("Failed retrieving catalog {id}"),
        ),
        "meta" => (
            state
                .addon
                .meta(id, &config)
                .await
                .map(|response| json_response(&response, Some(CacheControl::max_age(response.cache_max_age)))),
            format!("Failed retrieving catalog meta {id}"),
        ),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    match outcome {
        Ok(response) => response,
        Err(HandlerError::NotFound) => StatusCode::NOT_FOUND.into_response(),
        Err(HandlerError::Failed(cause)) => {
            tracing::error!(resource = target.name, kind, id, cause = %format!("{cause:#}"), "handler error: {failure}");
            (StatusCode::INTERNAL_SERVER_ERROR, HANDLER_ERROR).into_response()
        }
    }
}

async fn resolve(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path((moch, api_key, info_hash, entry, index)): Path<(String, String, String, String, String)>,
) -> Response {
    resolve_response(&state, peer, &headers, [moch, api_key, info_hash, entry, index]).await
}

async fn resolve_named(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path((moch, api_key, info_hash, entry, index, _filename)): Path<(String, String, String, String, String, String)>,
) -> Response {
    resolve_response(&state, peer, &headers, [moch, api_key, info_hash, entry, index]).await
}

async fn resolve_response(state: &AppState, peer: SocketAddr, headers: &HeaderMap, parts: [String; 5]) -> Response {
    let [moch_key, api_key, info_hash, cached_entry_info, index] = parts;
    if [&moch_key, &api_key, &info_hash, &cached_entry_info].iter().any(|part| part.is_empty()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let host = request_origin(headers);
    let params = ResolveParams {
        moch_key,
        api_key,
        info_hash: info_hash.to_lowercase(),
        cached_entry_info,
        file_index: index.parse().ok(),
        ip: client_ip(headers, Some(peer)),
        host: host.clone(),
        is_browser: is_browser(headers),
    };
    let (moch_key, info_hash) = (params.moch_key.clone(), params.info_hash.clone());
    let Some(resolved) = state.addon.mochs().resolve(params).await else {
        tracing::warn!(moch = moch_key, info_hash, error = "not found", "resolve failed");
        return StatusCode::NOT_FOUND.into_response();
    };
    redirect_response(&resolved, &host)
}

fn redirect_response(resolved: &Resolved, host: &str) -> Response {
    let (target, cacheable) = match resolved {
        Resolved::Url(url) => (url.clone(), true),
        Resolved::Message(message) => (format!("{host}/{}", message.path()), false),
    };
    let Ok(location) = HeaderValue::from_str(&target) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = StatusCode::FOUND.into_response();
    if cacheable {
        response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(RESOLVED_URL_CACHE_CONTROL));
    }
    response.headers_mut().insert(header::LOCATION, location);
    response
}

#[cfg(test)]
mod tests {
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt as _;

    use super::*;
    use crate::{
        domain::repository::TorrentRepository,
        infrastructure::cache::{Cache, Stores},
        infrastructure::repository::Repository,
        providers::static_videos::StaticResponse,
        providers::{Context, Endpoints, Mochs, default_providers},
    };

    fn test_app() -> NormalizePath<Router> {
        let metrics = Metrics::new();
        let repository: Arc<dyn TorrentRepository> =
            Arc::new(Repository::connect("postgres://nobody:nobody@127.0.0.1:1/none", metrics.clone()).unwrap());
        let cache = Arc::new(Cache::new(metrics.clone(), Stores { streams: None, availability: None }));
        let context = Arc::new(Context {
            endpoints: Endpoints::default(),
            repository: Arc::clone(&repository),
            cache: Arc::clone(&cache),
            metrics: metrics.clone(),
            http: debrid::Http::new(std::time::Duration::from_secs(1)).unwrap(),
        });
        let rate_limiter = RateLimiter::new(None, metrics.clone());
        let state = Arc::new(AppState {
            addon: Addon::new(repository, cache, Mochs::new(Arc::clone(&context), default_providers(&context))),
            metrics,
            rate_limiter,
            metrics_credentials: Some(("user".to_owned(), "secret".to_owned())),
        });
        app(state, FsPath::new("/nonexistent"))
    }

    async fn call(method: Method, path: &str) -> Response {
        let mut request = HttpRequest::builder().method(method).uri(path).body(Body::empty()).unwrap();
        request.extensions_mut().insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 4000))));
        test_app().oneshot(request).await.unwrap()
    }

    #[tokio::test]
    async fn redirects_roots_to_the_configure_page() {
        let response = call(Method::GET, "/lite").await;
        assert!(response.status().is_redirection());
        assert_eq!(response.headers()[header::LOCATION], "/lite/configure");
    }

    #[tokio::test]
    async fn serves_manifests_for_get_and_head() {
        for method in [Method::GET, Method::HEAD] {
            let response = call(method, "/manifest.json").await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json; charset=utf-8");
        }
    }

    #[tokio::test]
    async fn compresses_responses_for_clients_that_accept_gzip() {
        let mut request = HttpRequest::builder()
            .uri("/manifest.json")
            .header(header::ACCEPT_ENCODING, "gzip")
            .body(Body::empty())
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 4000))));
        let response = test_app().oneshot(request).await.unwrap();
        assert_eq!(response.headers()[header::CONTENT_ENCODING], "gzip");
        assert!(call(Method::GET, "/manifest.json").await.headers().get(header::CONTENT_ENCODING).is_none());
    }

    #[tokio::test]
    async fn tolerates_a_trailing_slash() {
        assert_eq!(call(Method::GET, "/configure/").await.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn adds_cors_to_dynamic_routes() {
        let response = call(Method::GET, "/manifest.json").await;
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    }

    #[tokio::test]
    async fn rejects_empty_path_parameters() {
        assert_eq!(call(Method::GET, "/stream/series/.json").await.status(), StatusCode::NOT_FOUND);
        assert_eq!(call(Method::GET, "/cfg//movie/tt1.json").await.status(), StatusCode::NOT_FOUND);
        assert_eq!(call(Method::GET, "/resolve/torbox//hash/file/1").await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn answers_unsupported_types_with_an_empty_stream_list() {
        let response = call(Method::GET, "/stream/tv/tt1.json").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], ", public");
        let body = axum::body::to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], br#"{"streams":[]}"#);
    }

    #[tokio::test]
    async fn unknown_resources_are_not_found() {
        assert_eq!(call(Method::GET, "/foo/movie/tt1.json").await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn metrics_require_credentials() {
        assert_eq!(call(Method::GET, "/metrics").await.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn invalid_debrid_tokens_resolve_to_the_access_video() {
        let response = call(Method::GET, "/resolve/torbox/short/aaaa/file/0").await;
        assert!(response.status().is_redirection());
        let location = response.headers()[header::LOCATION].to_str().unwrap();
        assert!(location.ends_with("videos/failed_access_v3.mp4"));
        assert!(response.headers().get(header::CACHE_CONTROL).is_none());
    }

    #[test]
    fn url_results_redirect_with_the_resolved_cache_control() {
        let response = redirect_response(&Resolved::Url("https://cdn.example/a.mkv".to_owned()), "http://addon");
        assert_eq!(response.status(), StatusCode::FOUND);
        assert_eq!(response.headers()[header::LOCATION], "https://cdn.example/a.mkv");
        assert_eq!(response.headers()[header::CACHE_CONTROL], RESOLVED_URL_CACHE_CONTROL);
    }

    #[test]
    fn message_results_redirect_to_the_host_video_without_cache_control() {
        let response = redirect_response(&Resolved::Message(StaticResponse::Downloading), "http://addon");
        assert_eq!(response.status(), StatusCode::FOUND);
        assert_eq!(response.headers()[header::LOCATION], "http://addon/videos/downloading_v3.mp4");
        assert!(response.headers().get(header::CACHE_CONTROL).is_none());
    }

    #[test]
    fn unencodable_locations_are_not_found() {
        let response = redirect_response(&Resolved::Url("bad\nurl".to_owned()), "http://addon");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn labels_metrics_by_resource_and_debrid() {
        assert_eq!(
            route_labels("/realdebrid=abc/stream/movie/tt1.json"),
            ("stream".to_owned(), "realdebrid".to_owned())
        );
        assert_eq!(route_labels("/resolve/torbox/key/h/f/1"), ("resolve".to_owned(), "torbox".to_owned()));
        assert_eq!(route_labels("/manifest.json"), ("manifest".to_owned(), "na".to_owned()));
    }

    #[test]
    fn empty_cache_fields_render_a_bare_public_directive() {
        assert_eq!(CacheControl { max_age: None, stale_revalidate: None, stale_error: None }.to_string(), ", public");
    }
}
