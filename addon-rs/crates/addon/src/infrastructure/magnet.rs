use std::{collections::HashSet, sync::LazyLock, time::Duration};

use parking_lot::RwLock;
use rand::seq::IndexedRandom;

use crate::{
    domain::content_type::ContentType, domain::filter::PROVIDERS, domain::repository::TorrentRepository,
    domain::title_helper::extract_provider, providers::helper::encode_uri_component,
};

const TRACKERS_URL: &str = "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt";
const TRACKERS_RETRIES: u32 = 2;
const ANIME_TRACKERS: &[&str] = &[
    "http://nyaa.tracker.wf:7777/announce",
    "http://anidex.moe:6969/announce",
    "http://tracker.anirena.com:80/announce",
    "udp://tracker.uw0.xyz:6969/announce",
    "http://share.camoe.cn:8080/announce",
    "http://t.nyaatracker.com:80/announce",
];
const RUSSIAN_TRACKERS: &[&str] = &[
    "udp://opentor.net:6969",
    "http://bt.t-ru.org/ann?magnet",
    "http://bt2.t-ru.org/ann?magnet",
    "http://bt3.t-ru.org/ann?magnet",
    "http://bt4.t-ru.org/ann?magnet",
];
const USER_AGENTS: &[&str] = &[
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

#[derive(Default)]
struct Trackers {
    anime: Vec<String>,
    russian: Vec<String>,
}

static TRACKERS: LazyLock<RwLock<Trackers>> = LazyLock::new(RwLock::default);

static RUSSIAN_LABELS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    PROVIDERS.iter().filter(|provider| provider.foreign == Some("🇷🇺")).map(|provider| provider.label).collect()
});

static ANIME_LABELS: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| PROVIDERS.iter().filter(|provider| provider.anime).map(|provider| provider.label).collect());

pub fn random_user_agent() -> &'static str {
    USER_AGENTS.choose(&mut rand::rng()).copied().unwrap_or(USER_AGENTS[0])
}

pub async fn magnet_link(repository: &dyn TorrentRepository, info_hash: &str) -> String {
    let torrent = repository.torrent(info_hash).await.ok().flatten();
    let torrent_trackers: Vec<String> = torrent
        .as_ref()
        .and_then(|torrent| torrent.trackers.as_deref())
        .map(|trackers| trackers.split(',').map(str::to_owned).collect())
        .unwrap_or_default();
    let (anime, russian) = {
        let trackers = TRACKERS.read();
        let is_anime = torrent.as_ref().is_some_and(|torrent| torrent.kind == ContentType::Anime.as_str());
        let is_russian = torrent.as_ref().is_some_and(|torrent| RUSSIAN_LABELS.contains(torrent.provider.as_str()));
        (
            if is_anime { trackers.anime.clone() } else { Vec::new() },
            if is_russian { trackers.russian.clone() } else { Vec::new() },
        )
    };
    let trackers = unique(torrent_trackers.into_iter().chain(anime).chain(russian));
    encode_magnet(info_hash, torrent.as_ref().map(|torrent| torrent.title.as_str()), &trackers)
}

pub fn encode_magnet(info_hash: &str, name: Option<&str>, trackers: &[String]) -> String {
    let mut parts = vec![format!("xt=urn:btih:{info_hash}")];
    if let Some(name) = name.filter(|name| !name.is_empty()) {
        parts.push(format!("dn={}", encode_uri_component(name).replace("%20", "+")));
    }
    parts.extend(trackers.iter().map(|tracker| format!("tr={}", encode_uri_component(tracker))));
    format!("magnet:?{}", parts.join("&"))
}

pub async fn init_best_trackers() {
    let best = best_trackers().await;
    let mut trackers = TRACKERS.write();
    trackers.anime = unique(best.iter().cloned().chain(ANIME_TRACKERS.iter().map(|tracker| (*tracker).to_owned())));
    trackers.russian = unique(best.iter().cloned().chain(RUSSIAN_TRACKERS.iter().map(|tracker| (*tracker).to_owned())));
    tracing::info!(count = best.len(), trackers = ?best, "Retrieved best trackers");
}

async fn best_trackers() -> Vec<String> {
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(30)).build() {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(%error, "Failed retrieving best trackers");
            return Vec::new();
        }
    };
    let mut attempt = 0;
    loop {
        let result = async {
            let response =
                client.get(TRACKERS_URL).header("User-Agent", random_user_agent()).send().await?.error_for_status()?;
            response.text().await
        }
        .await;
        match result {
            Ok(text) => {
                return text.trim().split("\n\n").filter(|line| !line.is_empty()).map(str::to_owned).collect();
            }
            Err(error) if attempt >= TRACKERS_RETRIES => {
                tracing::warn!(%error, "Failed retrieving best trackers");
                return Vec::new();
            }
            Err(_) => attempt += 1,
        }
    }
}

pub fn get_sources(trackers: Option<&str>, info_hash: &str) -> Option<Vec<String>> {
    let trackers = trackers.filter(|trackers| !trackers.is_empty())?;
    Some(trackers.split(',').map(|tracker| format!("tracker:{tracker}")).chain([format!("dht:{info_hash}")]).collect())
}

fn sources_from(trackers: &[String], info_hash: &str) -> Vec<String> {
    trackers.iter().map(|tracker| format!("tracker:{tracker}")).chain([format!("dht:{info_hash}")]).collect()
}

pub fn enrich_stream_sources(streams: &mut [crate::domain::stream::Stream]) {
    let trackers = TRACKERS.read();
    for stream in streams {
        let Some(provider) = extract_provider(&stream.title) else {
            continue;
        };
        let info_hash = stream.info_hash.as_deref().unwrap_or_default();
        if ANIME_LABELS.contains(provider) {
            stream.sources = Some(sources_from(&trackers.anime, info_hash));
        } else if RUSSIAN_LABELS.contains(provider) {
            let existing = stream.sources.take().unwrap_or_default();
            stream.sources = Some(unique(existing.into_iter().chain(sources_from(&trackers.russian, info_hash))));
        }
    }
}

fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    items.into_iter().filter(|item| seen.insert(item.clone())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_magnet_with_name_and_trackers() {
        let magnet = encode_magnet("abc", Some("My Movie (2020)"), &["udp://t:1/announce".to_owned()]);
        assert_eq!(magnet, "magnet:?xt=urn:btih:abc&dn=My+Movie+(2020)&tr=udp%3A%2F%2Ft%3A1%2Fannounce");
    }

    #[test]
    fn sources_require_trackers() {
        assert_eq!(get_sources(None, "h"), None);
        assert_eq!(get_sources(Some(""), "h"), None);
        assert_eq!(get_sources(Some("a,b"), "h").unwrap(), vec!["tracker:a", "tracker:b", "dht:h"]);
    }
}
