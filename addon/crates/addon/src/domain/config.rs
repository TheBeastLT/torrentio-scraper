use std::collections::HashMap;

use indexmap::IndexMap;

use crate::{
    domain::{
        filter::{PROVIDERS, QUALITIES, Quality},
        sort::SortOrder,
        title_helper::parse_size,
    },
    providers::{MOCHS, options},
};

const PROVIDERS_KEY: &str = "providers";
const LANGUAGES_KEY: &str = "language";
const QUALITY_KEY: &str = "qualityfilter";
const SIZE_KEY: &str = "sizefilter";
const SORT_KEY: &str = "sort";
const LIMIT_KEY: &str = "limit";
const DEBRID_OPTIONS_KEY: &str = "debridoptions";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SizeLimit {
    pub label: String,
    pub bytes: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DebridOptions {
    pub exclude_download_links: bool,
    pub hide_catalog: bool,
}

impl DebridOptions {
    pub fn keys(self) -> Vec<&'static str> {
        [(self.exclude_download_links, options::NO_DOWNLOAD_LINKS), (self.hide_catalog, options::NO_CATALOG)]
            .into_iter()
            .filter_map(|(enabled, key)| enabled.then_some(key))
            .collect()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UserPreferences {
    pub providers: Option<Vec<String>>,
    pub languages: Vec<String>,
    pub qualities: Vec<Quality>,
    pub size_limits: Vec<SizeLimit>,
    pub sort: SortOrder,
    pub limit: Option<usize>,
    pub debrid: DebridOptions,
}

impl UserPreferences {
    pub fn size_limit(&self, movie: bool) -> Option<u64> {
        let selected = if movie { self.size_limits.first() } else { self.size_limits.last() };
        selected.map(|limit| limit.bytes)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProviderCredentials(IndexMap<String, String>);

impl ProviderCredentials {
    pub fn get(&self, provider: &str) -> Option<&str> {
        self.0.get(provider).map(String::as_str)
    }

    pub fn is_set(&self, provider: &str) -> bool {
        self.get(provider).is_some_and(|key| !key.is_empty())
    }

    pub fn configured(&self) -> impl Iterator<Item = &str> {
        self.0.keys().map(String::as_str)
    }
}

#[derive(Clone, Debug, Default)]
pub struct RequestContext {
    pub ip: Option<String>,
    pub host: String,
    pub extra: HashMap<String, String>,
}

#[derive(Clone, Debug, Default)]
pub struct Config {
    preferences: UserPreferences,
    credentials: ProviderCredentials,
    request: RequestContext,
}

impl Config {
    pub fn parse(configuration: &str) -> Self {
        match configuration {
            "" => Self::default(),
            "lite" => Self::lite(),
            "brazuca" => Self::brazuca(),
            _ => Self::from_pairs(configuration),
        }
    }

    fn from_pairs(configuration: &str) -> Self {
        let mut values: IndexMap<String, String> = IndexMap::new();
        for pair in configuration.split('|') {
            let mut parts = pair.split('=');
            if let (Some(key), Some(value), None) = (parts.next(), parts.next(), parts.next()) {
                values.insert(key.to_lowercase(), value.to_owned());
            }
        }
        let list = |key: &str, uppercase: bool| -> Option<Vec<String>> {
            values.get(key).filter(|value| !value.is_empty()).map(|value| {
                value.split(',').map(|item| if uppercase { item.to_uppercase() } else { item.to_lowercase() }).collect()
            })
        };
        let preferences = UserPreferences {
            providers: list(PROVIDERS_KEY, false),
            languages: list(LANGUAGES_KEY, false).unwrap_or_default(),
            qualities: list(QUALITY_KEY, false).map(|keys| parse_qualities(&keys)).unwrap_or_default(),
            size_limits: list(SIZE_KEY, true).map(parse_size_limits).unwrap_or_default(),
            sort: values.get(SORT_KEY).map_or_else(SortOrder::default, |sort| SortOrder::parse(sort)),
            limit: values.get(LIMIT_KEY).and_then(|limit| parse_limit(limit)),
            debrid: parse_debrid_options(&list(DEBRID_OPTIONS_KEY, false).unwrap_or_default()),
        };
        let credentials = ProviderCredentials(
            values
                .iter()
                .filter(|(key, _)| MOCHS.iter().any(|moch| moch.key == key.as_str()))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        );
        Self { preferences, credentials, request: RequestContext::default() }
    }

    fn lite() -> Self {
        let preferences = UserPreferences {
            providers: Some(
                PROVIDERS.iter().filter(|provider| provider.foreign.is_none()).map(|p| p.key.to_owned()).collect(),
            ),
            qualities: vec![Quality::Screener, Quality::Cam],
            limit: Some(1),
            ..UserPreferences::default()
        };
        Self { preferences, ..Self::default() }
    }

    fn brazuca() -> Self {
        let preferences = UserPreferences {
            providers: Some(
                PROVIDERS
                    .iter()
                    .filter(|provider| provider.foreign.is_none_or(|flag| flag == "🇵🇹"))
                    .map(|p| p.key.to_owned())
                    .collect(),
            ),
            languages: vec!["portuguese".to_owned()],
            ..UserPreferences::default()
        };
        Self { preferences, ..Self::default() }
    }

    #[must_use]
    pub fn with_request(mut self, request: RequestContext) -> Self {
        self.request = request;
        self
    }

    #[must_use]
    pub fn with_host(mut self, host: impl Into<String>) -> Self {
        self.request.host = host.into();
        self
    }

    pub fn preferences(&self) -> &UserPreferences {
        &self.preferences
    }

    pub fn credentials(&self) -> &ProviderCredentials {
        &self.credentials
    }

    pub fn skip(&self) -> u32 {
        self.request.extra.get("skip").and_then(|skip| skip.parse().ok()).unwrap_or(0)
    }

    pub fn host(&self) -> &str {
        &self.request.host
    }

    pub fn ip(&self) -> Option<&str> {
        self.request.ip.as_deref()
    }
}

fn parse_qualities(keys: &[String]) -> Vec<Quality> {
    QUALITIES.iter().copied().filter(|quality| keys.iter().any(|key| key == quality.key())).collect()
}

fn parse_size_limits(labels: Vec<String>) -> Vec<SizeLimit> {
    labels
        .into_iter()
        .map(|label| {
            let bytes = parse_size(&label);
            SizeLimit { label, bytes }
        })
        .collect()
}

fn parse_limit(limit: &str) -> Option<usize> {
    (!limit.is_empty() && limit.bytes().all(|byte| byte.is_ascii_digit()) && !limit.starts_with('0'))
        .then(|| limit.parse().ok())
        .flatten()
}

fn parse_debrid_options(keys: &[String]) -> DebridOptions {
    let has = |wanted: &str| keys.iter().any(|key| key == wanted);
    DebridOptions { exclude_download_links: has(options::NO_DOWNLOAD_LINKS), hide_catalog: has(options::NO_CATALOG) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pairs_into_typed_preferences() {
        let config =
            Config::parse("providers=YTS,EZTV|sort=Seeders|realdebrid=abc|sizefilter=2gb,4gb|limit=3|language=French");
        let preferences = config.preferences();
        assert_eq!(preferences.providers.as_deref(), Some(&["yts".to_owned(), "eztv".to_owned()][..]));
        assert_eq!(preferences.sort, SortOrder::Seeders);
        assert_eq!(preferences.limit, Some(3));
        assert_eq!(preferences.languages, ["french"]);
        assert_eq!(
            preferences.size_limits.iter().map(|limit| limit.label.as_str()).collect::<Vec<_>>(),
            ["2GB", "4GB"]
        );
        assert_eq!(preferences.size_limit(true), Some(2 * 1024 * 1024 * 1024));
        assert_eq!(preferences.size_limit(false), Some(4 * 1024 * 1024 * 1024));
        assert!(config.credentials().is_set("realdebrid"));
    }

    #[test]
    fn defaults_apply_when_nothing_is_configured() {
        let preferences = Config::parse("").preferences().clone();
        assert_eq!(preferences, UserPreferences::default());
        assert_eq!(preferences.sort, SortOrder::QualitySeeders);
        assert_eq!(preferences.size_limit(true), None);
    }

    #[test]
    fn ignores_malformed_pairs_and_invalid_values() {
        let config = Config::parse("broken|a=b=c|sort=whatever|limit=0|qualityfilter=720p,nonsense");
        let preferences = config.preferences();
        assert_eq!(preferences.sort, SortOrder::QualitySeeders);
        assert_eq!(preferences.limit, None);
        assert_eq!(preferences.qualities, [Quality::P720]);
    }

    #[test]
    fn keeps_credentials_in_configured_order() {
        let config = Config::parse("torbox=aaaaaaaaaaaaaaaaaaaa|realdebrid=bbbbbbbbbbbbbbbbbbbb|sort=size");
        assert_eq!(config.credentials().configured().collect::<Vec<_>>(), ["torbox", "realdebrid"]);
    }

    #[test]
    fn debrid_options_round_trip_to_keys() {
        let config = Config::parse("debridoptions=nodownloadlinks,nocatalog");
        let debrid = config.preferences().debrid;
        assert!(debrid.exclude_download_links && debrid.hide_catalog);
        assert_eq!(debrid.keys(), ["nodownloadlinks", "nocatalog"]);
    }

    #[test]
    fn request_context_carries_host_ip_and_skip() {
        let config = Config::parse("").with_request(RequestContext {
            ip: Some("1.2.3.4".to_owned()),
            host: "http://localhost".to_owned(),
            extra: HashMap::from([("skip".to_owned(), "100".to_owned())]),
        });
        assert_eq!((config.host(), config.ip(), config.skip()), ("http://localhost", Some("1.2.3.4"), 100));
    }

    #[test]
    fn lite_preconfiguration_excludes_foreign_providers() {
        let preferences = Config::parse("lite").preferences().clone();
        let providers = preferences.providers.unwrap();
        assert!(providers.contains(&"yts".to_owned()));
        assert!(!providers.contains(&"rutor".to_owned()));
        assert_eq!(preferences.limit, Some(1));
        assert_eq!(preferences.qualities, [Quality::Screener, Quality::Cam]);
    }

    #[test]
    fn brazuca_preconfiguration_keeps_portuguese_providers() {
        let preferences = Config::parse("brazuca").preferences().clone();
        assert!(preferences.providers.unwrap().contains(&"bludv".to_owned()));
        assert_eq!(preferences.languages, ["portuguese"]);
    }
}
