use std::sync::LazyLock;

use regex::Regex;

static SEEDERS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"👤 ([0-9]+)").expect("valid regex"));
static SIZE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"💾 ([0-9.]+ [A-Za-z0-9_]+)").expect("valid regex"));
static PROVIDER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"⚙.* ([^ \n]+)").expect("valid regex"));

pub fn extract_seeders(title: &str) -> u64 {
    SEEDERS.captures(title).and_then(|captures| captures[1].parse().ok()).unwrap_or(0)
}

pub fn extract_size(title: &str) -> u64 {
    SIZE.captures(title).map_or(0, |captures| parse_size(&captures[1]))
}

pub fn extract_provider(title: &str) -> Option<&str> {
    PROVIDER.captures(title).and_then(|captures| captures.get(1)).map(|found| found.as_str())
}

pub fn parse_size(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    let scale: f64 = if text.contains("TB") {
        1024.0 * 1024.0 * 1024.0 * 1024.0
    } else if text.contains("GB") {
        1024.0 * 1024.0 * 1024.0
    } else if text.contains("MB") {
        1024.0 * 1024.0
    } else if text.contains("kB") {
        1024.0
    } else {
        1.0
    };
    let number: String = text.replace(',', "");
    (parse_float_prefix(&number) * scale).floor() as u64
}

fn parse_float_prefix(text: &str) -> f64 {
    let end = text
        .char_indices()
        .take_while(|(index, character)| {
            character.is_ascii_digit() || *character == '.' || (*index == 0 && *character == '-')
        })
        .last()
        .map_or(0, |(index, character)| index + character.len_utf8());
    text[..end].parse().unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TITLE: &str = "Some.Release.1080p\n👤 12 💾 1.5 GB ⚙️ ThePirateBay\n🇬🇧";

    #[test]
    fn extracts_seeders() {
        assert_eq!(extract_seeders(TITLE), 12);
        assert_eq!(extract_seeders("no seeders"), 0);
    }

    #[test]
    fn extracts_size() {
        assert_eq!(extract_size(TITLE), 1_610_612_736);
        assert_eq!(extract_size("none"), 0);
    }

    #[test]
    fn extracts_provider() {
        assert_eq!(extract_provider(TITLE), Some("ThePirateBay"));
        assert_eq!(extract_provider("none"), None);
    }

    #[test]
    fn parses_sizes() {
        assert_eq!(parse_size("2 kB"), 2048);
        assert_eq!(parse_size("1,5 MB"), 15_728_640);
        assert_eq!(parse_size(""), 0);
    }
}
