use std::net::{IpAddr, SocketAddr};

use axum::http::HeaderMap;

const HEADER: &str = "x-real-ip";

pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>) -> Option<String> {
    headers
        .get(HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_ip)
        .or_else(|| peer.map(|peer| peer.ip().to_string()))
}

fn parse_ip(value: &str) -> Option<String> {
    let candidate = value.trim();
    candidate
        .parse::<IpAddr>()
        .ok()
        .or_else(|| candidate.parse::<SocketAddr>().ok().map(|socket| socket.ip()))
        .map(|ip| ip.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(*name, value.parse().unwrap());
        }
        headers
    }

    #[test]
    fn uses_the_real_ip_header() {
        let headers = headers(&[("x-real-ip", "203.0.113.7")]);
        assert_eq!(client_ip(&headers, None).as_deref(), Some("203.0.113.7"));
    }

    #[test]
    fn real_ip_header_wins_over_the_peer_address() {
        let headers = headers(&[("x-real-ip", "2001:db8::1")]);
        let peer: SocketAddr = "198.51.100.2:4000".parse().unwrap();
        assert_eq!(client_ip(&headers, Some(peer)).as_deref(), Some("2001:db8::1"));
    }

    #[test]
    fn ignores_client_supplied_forwarding_headers() {
        let headers = headers(&[
            ("x-client-ip", "203.0.113.7"),
            ("x-forwarded-for", "203.0.113.8, 10.0.0.1"),
            ("cf-connecting-ip", "203.0.113.9"),
            ("true-client-ip", "203.0.113.10"),
            ("forwarded", "for=203.0.113.11"),
        ]);
        let peer: SocketAddr = "198.51.100.2:4000".parse().unwrap();
        assert_eq!(client_ip(&headers, Some(peer)).as_deref(), Some("198.51.100.2"));
    }

    #[test]
    fn falls_back_to_the_peer_address() {
        let peer: SocketAddr = "198.51.100.2:4000".parse().unwrap();
        assert_eq!(client_ip(&HeaderMap::new(), Some(peer)).as_deref(), Some("198.51.100.2"));
    }

    #[test]
    fn ignores_garbage_values() {
        let headers = headers(&[("x-real-ip", "unknown")]);
        assert_eq!(client_ip(&headers, None), None);
    }

    #[test]
    fn accepts_a_socket_address() {
        let headers = headers(&[("x-real-ip", " 203.0.113.7:5000 ")]);
        assert_eq!(client_ip(&headers, None).as_deref(), Some("203.0.113.7"));
    }

    #[test]
    fn accepts_a_bracketed_ipv6_socket_address() {
        let headers = headers(&[("x-real-ip", "[2001:db8::1]:5000")]);
        assert_eq!(client_ip(&headers, None).as_deref(), Some("2001:db8::1"));
    }

    #[test]
    fn keeps_a_bare_ipv6_address_canonical() {
        let headers = headers(&[("x-real-ip", "2001:0db8:0000:0000:0000:0000:0000:0001")]);
        assert_eq!(client_ip(&headers, None).as_deref(), Some("2001:db8::1"));
    }
}
