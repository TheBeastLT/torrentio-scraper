use std::{
    net::{IpAddr, Ipv6Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use addon::{
    application::Addon,
    domain::TorrentRepository,
    http::{AppState, app},
    infrastructure::{Cache, Metrics, RateLimiter, Repository, Stores, init_best_trackers, logging, store},
    providers::{Context, Endpoints, Mochs, default_providers},
};
use anyhow::Context as _;
use axum::{ServiceExt, extract::Request};
use tokio::{net::TcpListener, signal};

#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

const DEFAULT_PORT: u16 = 7000;
const DEBRID_TIMEOUT: Duration = Duration::from_secs(10);
const FORCE_EXIT: Duration = Duration::from_secs(40);

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    logging::init();
    let metrics = Metrics::new();
    metrics.spawn_lag_sampler();
    let database_url = env("DATABASE_URI").context("DATABASE_URI is required")?;
    let repository = Arc::new(Repository::connect(&database_url, metrics.clone())?);

    let stores = match env("MONGODB_URI") {
        Some(uri) => {
            let client = store::connect(&uri).await?;
            let database = env("MONGODB_DATABASE");
            let streams = store::Store::new(&client, database.as_deref(), "torrentio_addon_stream", true);
            let availability = store::Store::new(&client, database.as_deref(), "torrentio_addon_availability", false);
            tokio::spawn({
                let (streams, availability) = (streams.clone(), availability.clone());
                async move {
                    tokio::join!(streams.ensure_indexes(), availability.ensure_indexes());
                }
            });
            Stores { streams: Some(streams), availability: Some(availability) }
        }
        None => Stores { streams: None, availability: None },
    };
    let cache = Arc::new(Cache::new(metrics.clone(), stores));
    let context = Arc::new(Context {
        endpoints: Endpoints { torbox: env("TORBOX_API_URL"), highway: env("HIGHWAY_API_BASE") },
        repository: Arc::clone(&repository) as Arc<dyn TorrentRepository>,
        cache: Arc::clone(&cache),
        metrics: metrics.clone(),
        http: debrid::Http::new(DEBRID_TIMEOUT)?,
    });
    let addon = Addon::new(
        Arc::clone(&repository) as Arc<dyn TorrentRepository>,
        Arc::clone(&cache),
        Mochs::new(Arc::clone(&context), default_providers(&context)),
    );
    let rate_limiter = RateLimiter::new(env("REDIS_URL").as_deref(), metrics.clone());
    let credentials = env("METRICS_USER").zip(env("METRICS_PASSWORD"));
    let static_dir = PathBuf::from(env("STATIC_DIR").unwrap_or_else(|| "static".to_owned()));
    let rate_limit_sync = rate_limiter.spawn_sync();
    let state =
        Arc::new(AppState { addon, metrics, rate_limiter: rate_limiter.clone(), metrics_credentials: credentials });

    let port = env("PORT").and_then(|port| port.parse().ok()).unwrap_or(DEFAULT_PORT);
    let host = env("HOST")
        .map_or(Ok(IpAddr::V6(Ipv6Addr::UNSPECIFIED)), |host| host.parse())
        .context("HOST is not an ip address")?;
    let listener = TcpListener::bind(SocketAddr::new(host, port)).await?;
    tokio::spawn(async move {
        init_best_trackers().await;
        tracing::info!(port, "Started addon");
    });
    axum::serve(
        listener,
        ServiceExt::<Request>::into_make_service_with_connect_info::<SocketAddr>(app(state, &static_dir)),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    rate_limit_sync.stop().await;
    rate_limiter.flush().await;
    repository.close().await;
    cache.drain().await;
    Ok(())
}

async fn shutdown() {
    let terminate = async {
        match signal::unix::signal(signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        _ = signal::ctrl_c() => tracing::info!("Received SIGINT, shutting down gracefully"),
        () = terminate => tracing::info!("Received SIGTERM, shutting down gracefully"),
    }
    tokio::spawn(async {
        tokio::time::sleep(FORCE_EXIT).await;
        std::process::exit(1);
    });
}
