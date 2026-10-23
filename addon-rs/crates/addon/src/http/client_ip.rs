use std::net::{IpAddr, SocketAddr};

use axum::http::HeaderMap;

const HEADERS: &[&str] = &[
    "x-client-ip",
    "x-forwarded-for",
    "cf-connecting-ip",
    "fastly-client-ip",
    "true-client-ip",
    "x-real-ip",
    "x-cluster-client-ip",
    "x-forwarded",
    "forwarded-for",
    "forwarded",
];

pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>) -> Option<String> {
    HEADERS
        .iter()
        .filter_map(|name| headers.get(*name)?.to_str().ok())
        .find_map(first_ip)
        .or_else(|| peer.map(|peer| peer.ip().to_string()))
}

fn first_ip(value: &str) -> Option<String> {
    value.split(',').map(str::trim).find_map(|candidate| {
        candidate
            .parse::<IpAddr>()
            .ok()
            .or_else(|| candidate.parse::<SocketAddr>().ok().map(|socket| socket.ip()))
            .map(|ip| ip.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_leftmost_forwarded_address() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.7, 10.0.0.1".parse().unwrap());
        assert_eq!(client_ip(&headers, None).as_deref(), Some("203.0.113.7"));
    }

    #[test]
    fn falls_back_to_the_peer_address() {
        let peer: SocketAddr = "198.51.100.2:4000".parse().unwrap();
        assert_eq!(client_ip(&HeaderMap::new(), Some(peer)).as_deref(), Some("198.51.100.2"));
    }

    #[test]
    fn ignores_garbage_values() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "unknown".parse().unwrap());
        assert_eq!(client_ip(&headers, None), None);
    }
}
