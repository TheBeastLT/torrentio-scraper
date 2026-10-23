use serde_json::{Value, json};

use crate::{
    domain::config::Config,
    domain::content_type::ContentType,
    domain::filter::PROVIDERS,
    providers::{MOCHS, options::show_debrid_catalog},
};

pub fn manifest(config: &Config) -> Value {
    json!({
        "id": "com.stremio.torrentio.addon",
        "version": "0.0.15",
        "name": name(config),
        "description": description(config),
        "catalogs": catalogs(config),
        "resources": resources(config),
        "types": [ContentType::Movie, ContentType::Series, ContentType::Anime, ContentType::Other],
        "background": format!("{}/images/background_v1.jpg", config.host()),
        "logo": format!("{}/images/logo_v1.png", config.host()),
        "behaviorHints": { "configurable": true, "configurationRequired": false },
    })
}

fn configured_mochs(config: &Config) -> impl Iterator<Item = &'static crate::providers::MochInfo> + '_ {
    MOCHS.iter().filter(|moch| config.credentials().is_set(moch.key))
}

fn name(config: &Config) -> String {
    let suffix = configured_mochs(config).map(|moch| moch.short_name).collect::<Vec<_>>().join("/");
    ["Torrentio", suffix.as_str()].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join(" ")
}

fn description(config: &Config) -> String {
    let enabled = config.preferences().providers.as_deref();
    let providers = PROVIDERS
        .iter()
        .map(|provider| {
            let on = enabled.is_none_or(|list| list.iter().any(|key| key == provider.key));
            format!("{}{}", provider.label, if on { "(+)" } else { "(-)" })
        })
        .collect::<Vec<_>>()
        .join(", ");
    let enabled_mochs = configured_mochs(config).map(|moch| moch.name).collect::<Vec<_>>().join(" & ");
    let possible_mochs = MOCHS.iter().map(|moch| moch.name).collect::<Vec<_>>().join("/");
    let mochs = if enabled_mochs.is_empty() { String::new() } else { format!(" and {enabled_mochs} enabled") };
    format!(
        "Provides torrent streams from scraped torrent providers. Currently supports {providers}{mochs}. To configure providers, {possible_mochs} support and other settings visit https://torrentio.strem.fun"
    )
}

fn catalogs(config: &Config) -> Vec<Value> {
    if !show_debrid_catalog(config) {
        return Vec::new();
    }
    configured_mochs(config)
        .flat_map(|moch| {
            moch.catalogs.iter().map(move |catalog| {
                if catalog.is_empty() {
                    json!({ "id": format!("torrentio-{}", moch.key), "name": moch.name, "type": "other", "extra": [{ "name": "skip" }] })
                } else {
                    json!({
                        "id": format!("torrentio-{}-{}", moch.key, catalog.to_lowercase()),
                        "name": format!("{} {catalog}", moch.name),
                        "type": "other",
                        "extra": [{ "name": "skip" }],
                    })
                }
            })
        })
        .collect()
}

fn resources(config: &Config) -> Vec<Value> {
    let stream = json!({ "name": "stream", "types": ["movie", "series", "anime"], "idPrefixes": ["tt", "kitsu"] });
    let mochs: Vec<&str> = configured_mochs(config).map(|moch| moch.key).collect();
    if show_debrid_catalog(config) && !mochs.is_empty() {
        return vec![stream, json!({ "name": "meta", "types": ["other"], "idPrefixes": mochs })];
    }
    vec![stream]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_addon_after_configured_debrid() {
        let config = Config::parse("realdebrid=abcdefghijklmnopqrstuvwxyz").with_host("http://localhost");
        assert_eq!(manifest(&config)["name"], "Torrentio RD");
        assert_eq!(manifest(&config)["catalogs"][0]["id"], "torrentio-realdebrid");
    }

    #[test]
    fn omits_meta_resource_without_debrid() {
        let manifest = manifest(&Config::parse(""));
        assert_eq!(manifest["resources"].as_array().unwrap().len(), 1);
        assert_eq!(manifest["name"], "Torrentio");
    }

    #[test]
    fn torbox_exposes_three_catalogs() {
        let config = Config::parse("torbox=abcdefghijklmnopqrstuvwxyz");
        let ids: Vec<String> = manifest(&config)["catalogs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|catalog| catalog["id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(ids, ["torrentio-torbox-torrents", "torrentio-torbox-usenet", "torrentio-torbox-webdl"]);
    }
}
