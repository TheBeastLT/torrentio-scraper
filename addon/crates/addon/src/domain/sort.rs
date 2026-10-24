use std::{cmp::Ordering, sync::LazyLock};

use regex::Regex;

use crate::{
    domain::config::Config,
    domain::filter::Quality,
    domain::languages,
    domain::stream::Stream,
    domain::title_helper::{extract_seeders, extract_size},
    providers,
};

const HEALTHY_SEEDERS: u64 = 5;
const SEEDED_SEEDERS: u64 = 1;
const MIN_HEALTHY_COUNT: usize = 50;
const MAX_UNHEALTHY_COUNT: usize = 5;

pub const SORT_KEY: &str = "sort";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SortOrder {
    #[default]
    QualitySeeders,
    QualitySize,
    Seeders,
    Size,
}

impl SortOrder {
    pub fn parse(value: &str) -> Self {
        match value.to_lowercase().as_str() {
            "seeders" => Self::Seeders,
            "size" => Self::Size,
            "qualitysize" => Self::QualitySize,
            _ => Self::QualitySeeders,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::QualitySeeders => "quality",
            Self::QualitySize => "qualitysize",
            Self::Seeders => "seeders",
            Self::Size => "size",
        }
    }
}

pub struct SortOption {
    pub key: &'static str,
    pub description: &'static str,
}

pub const SORT_OPTIONS: &[SortOption] = &[
    SortOption { key: "quality", description: "By quality then seeders" },
    SortOption { key: "qualitysize", description: "By quality then size" },
    SortOption { key: "seeders", description: "By seeders" },
    SortOption { key: "size", description: "By size" },
];

static RESOLUTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[0-9]+p").expect("valid regex"));
static HDR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"HDR|DV").expect("valid regex"));
static EIGHT_K: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)8k").expect("valid regex"));
static FOUR_K: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)4k|uhd").expect("valid regex"));

pub fn sort_streams(streams: Vec<Stream>, config: &Config) -> Vec<Stream> {
    let preferences = config.preferences();
    let languages = Some(preferences.languages.as_slice())
        .filter(|languages| languages.first().is_some_and(|first| first != "english"));
    let Some(languages) = languages else {
        return sort_group(streams, config);
    };
    let (with_language, without_language): (Vec<Stream>, Vec<Stream>) =
        streams.into_iter().partition(|stream| languages::contains_language(&stream.title, languages));
    let mut sorted = sort_group(with_language, config);
    sorted.extend(sort_group(without_language, config));
    sorted
}

fn sort_group(streams: Vec<Stream>, config: &Config) -> Vec<Stream> {
    let preferences = config.preferences();
    let limit = preferences.limit;
    let sorted = sort_by_seeders(streams, config);
    match preferences.sort {
        SortOrder::Seeders => truncate(sorted, limit),
        SortOrder::Size => sort_by_size(sorted, limit),
        SortOrder::QualitySize => sort_by_quality(sorted, true, limit),
        SortOrder::QualitySeeders => sort_by_quality(sorted, false, limit),
    }
}

fn truncate(mut streams: Vec<Stream>, limit: Option<usize>) -> Vec<Stream> {
    if let Some(limit) = limit {
        streams.truncate(limit);
    }
    streams
}

fn sort_by_seeders(mut streams: Vec<Stream>, config: &Config) -> Vec<Stream> {
    if providers::has_moch_configured(config) {
        return streams;
    }
    let seeders: Vec<u64> = streams.iter().map(|stream| extract_seeders(&stream.title)).collect();
    let at_least = |minimum: u64| seeders.iter().filter(|count| **count >= minimum).count();
    let keep = |streams: Vec<Stream>, minimum: u64| -> Vec<Stream> {
        streams.into_iter().zip(&seeders).filter(|(_, count)| **count >= minimum).map(|(stream, _)| stream).collect()
    };
    if at_least(HEALTHY_SEEDERS) >= MIN_HEALTHY_COUNT {
        return keep(streams, HEALTHY_SEEDERS);
    }
    if at_least(SEEDED_SEEDERS) >= MAX_UNHEALTHY_COUNT {
        let mut seeded = keep(streams, SEEDED_SEEDERS);
        seeded.truncate(MIN_HEALTHY_COUNT);
        return seeded;
    }
    streams.truncate(MAX_UNHEALTHY_COUNT);
    streams
}

fn sort_by_size(streams: Vec<Stream>, limit: Option<usize>) -> Vec<Stream> {
    let mut keyed: Vec<(u64, Stream)> =
        streams.into_iter().map(|stream| (extract_size(&stream.title), stream)).collect();
    keyed.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    truncate(keyed.into_iter().map(|(_, stream)| stream).collect(), limit)
}

fn sort_by_quality(streams: Vec<Stream>, nested_by_size: bool, limit: Option<usize>) -> Vec<Stream> {
    let mut groups: Vec<(String, Vec<Stream>)> = Vec::new();
    for stream in streams {
        let quality = extract_quality(&stream.name);
        match groups.iter_mut().find(|(key, _)| *key == quality) {
            Some((_, members)) => members.push(stream),
            None => groups.push((quality, vec![stream])),
        }
    }
    groups.sort_by(|(a, _), (b, _)| compare_qualities(a, b));
    groups
        .into_iter()
        .flat_map(|(_, members)| {
            let members = if nested_by_size { sort_by_size(members, None) } else { members };
            truncate(members, limit)
        })
        .collect()
}

fn resolution_of(quality: &str) -> Option<u32> {
    RESOLUTION.is_match(quality).then(|| leading_integer(quality)).flatten()
}

fn leading_integer(text: &str) -> Option<u32> {
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok().filter(|value| *value != 0)
}

fn compare_qualities(a: &str, b: &str) -> Ordering {
    match (resolution_of(a), resolution_of(b)) {
        (Some(a), Some(b)) => b.cmp(&a),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => compare_utf16(a, b),
    }
}

fn compare_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn extract_quality(name: &str) -> String {
    let description = name.split('\n').nth(1);
    let with_hdr_score = |resolution: &str| {
        if description.is_some_and(|text| HDR.is_match(text)) {
            resolution.replace("0p", "1p")
        } else {
            resolution.to_owned()
        }
    };
    let Some(description) = description else {
        return "undefined".to_owned();
    };
    if let Some(found) = RESOLUTION.find(description) {
        with_hdr_score(found.as_str())
    } else if EIGHT_K.is_match(description) {
        with_hdr_score("4320p")
    } else if FOUR_K.is_match(description) {
        with_hdr_score("2060p")
    } else if Quality::Cam.matches(Some(description), None) {
        Quality::Cam.label().to_owned()
    } else if Quality::Other.matches(Some(description), None) {
        Quality::Other.label().to_owned()
    } else {
        description.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(name: &str, title: &str) -> Stream {
        Stream { name: name.to_owned(), title: title.to_owned(), ..Stream::default() }
    }

    #[test]
    fn extracts_quality_buckets() {
        assert_eq!(extract_quality("Torrentio\n1080p"), "1080p");
        assert_eq!(extract_quality("Torrentio\n1080p HDR"), "1081p");
        assert_eq!(extract_quality("Torrentio\n4k"), "2060p");
        assert_eq!(extract_quality("Torrentio\nBluRay"), Quality::Other.label());
        assert_eq!(extract_quality("Torrentio\nCAM"), Quality::Cam.label());
    }

    #[test]
    fn higher_resolution_sorts_first() {
        let config = Config::parse("");
        let streams = vec![
            stream("T\n720p", "a\n👤 9 ⚙️ x"),
            stream("T\n1080p", "b\n👤 9 ⚙️ x"),
            stream("T\n4k", "c\n👤 9 ⚙️ x"),
        ];
        let names: Vec<String> = sort_streams(streams, &config).into_iter().map(|stream| stream.title).collect();
        assert_eq!(names, vec!["c\n👤 9 ⚙️ x", "b\n👤 9 ⚙️ x", "a\n👤 9 ⚙️ x"]);
    }

    #[test]
    fn limit_applies_per_quality() {
        let config = Config::parse("limit=1");
        let streams = vec![stream("T\n1080p", "a\n👤 9"), stream("T\n1080p", "b\n👤 9"), stream("T\n720p", "c\n👤 9")];
        assert_eq!(sort_streams(streams, &config).len(), 2);
    }

    #[test]
    fn unhealthy_streams_are_trimmed_without_moch() {
        let config = Config::parse("");
        let streams: Vec<Stream> = (0..10).map(|index| stream("T\n720p", &format!("{index}\n👤 0"))).collect();
        assert_eq!(sort_streams(streams, &config).len(), MAX_UNHEALTHY_COUNT);
    }
}
