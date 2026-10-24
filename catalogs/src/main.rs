use std::{
    net::{IpAddr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use anyhow::Context as _;
use axum::{ServiceExt, extract::Request};
use catalogs::{
    application::{Catalogs, Settings},
    domain::{CacheStore, IdRepository, MetadataSource},
    http::{AppState, app},
    infrastructure::{
        Metadata, Metrics, Repository, Store, logging,
        metadata::{CINEMETA_URL, DEFAULT_TIMEOUT, KITSU_URL},
        store::{self, CATALOG_COLLECTION},
    },
};
use tokio::{net::TcpListener, signal};

#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

const DEFAULT_PORT: u16 = 7000;
const DEFAULT_BLOCKING_THREADS: usize = 8;
const FORCE_EXIT: Duration = Duration::from_secs(10);

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn env_number<T: std::str::FromStr + Default + PartialEq>(name: &str) -> Option<T> {
    env(name).and_then(|value| value.parse().ok()).filter(|value| *value != T::default())
}

fn settings() -> Settings {
    let defaults = Settings::default();
    Settings {
        cache_max_age: env_number("CACHE_MAX_AGE").unwrap_or(defaults.cache_max_age),
        max_concurrent: env_number("LIMIT_MAX_CONCURRENT").unwrap_or(defaults.max_concurrent),
        queue_size: env_number("LIMIT_QUEUE_SIZE").unwrap_or(defaults.queue_size),
    }
}

fn blocking_threads(configured: Option<String>) -> usize {
    configured.and_then(|value| value.parse().ok()).filter(|threads| *threads > 0).unwrap_or(DEFAULT_BLOCKING_THREADS)
}

fn main() -> anyhow::Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .max_blocking_threads(blocking_threads(env("TOKIO_MAX_BLOCKING_THREADS")))
        .build()?
        .block_on(run())
}

async fn run() -> anyhow::Result<()> {
    logging::init();
    let metrics = Metrics::new();
    metrics.spawn_lag_sampler();
    let database_url = env("DATABASE_URI").context("DATABASE_URI is required")?;
    let repository = Arc::new(Repository::connect(&database_url, metrics.clone())?);
    let store = match env("MONGODB_URI") {
        Some(uri) => {
            let client = store::connect(&uri).await?;
            let store = Store::new(&client, CATALOG_COLLECTION);
            tokio::spawn({
                let store = store.clone();
                async move { store.ensure_indexes().await }
            });
            Some(Arc::new(store) as Arc<dyn CacheStore>)
        }
        None => None,
    };
    let timeout = env_number("METADATA_TIMEOUT").map_or(DEFAULT_TIMEOUT, Duration::from_millis);
    let metadata = Metadata::new(
        &env("CINEMETA_URL").unwrap_or_else(|| CINEMETA_URL.to_owned()),
        &env("KITSU_URL").unwrap_or_else(|| KITSU_URL.to_owned()),
        timeout,
        metrics.clone(),
    )?;
    let catalogs = Catalogs::new(
        Arc::clone(&repository) as Arc<dyn IdRepository>,
        Arc::new(metadata) as Arc<dyn MetadataSource>,
        store,
        metrics.clone(),
        settings(),
    );
    let state =
        Arc::new(AppState { catalogs, metrics, metrics_credentials: env("METRICS_USER").zip(env("METRICS_PASSWORD")) });

    let port = env("PORT").and_then(|port| port.parse().ok()).unwrap_or(DEFAULT_PORT);
    let host = env("HOST")
        .map_or(Ok(IpAddr::V6(Ipv6Addr::UNSPECIFIED)), |host| host.parse())
        .context("HOST is not an ip address")?;
    let listener = TcpListener::bind(SocketAddr::new(host, port)).await?;
    tracing::info!("Started addon at: http://localhost:{port}");
    axum::serve(listener, ServiceExt::<Request>::into_make_service(app(state)))
        .with_graceful_shutdown(shutdown())
        .await?;
    repository.close().await;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocking_thread_cap_defaults_when_unset_or_invalid() {
        assert_eq!(blocking_threads(None), DEFAULT_BLOCKING_THREADS);
        assert_eq!(blocking_threads(Some("abc".to_owned())), DEFAULT_BLOCKING_THREADS);
        assert_eq!(blocking_threads(Some("0".to_owned())), DEFAULT_BLOCKING_THREADS);
        assert_eq!(blocking_threads(Some("16".to_owned())), 16);
    }
}
