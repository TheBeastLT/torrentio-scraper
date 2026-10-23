use askama::Template;
use serde::Serialize;
use serde_json::Value;

use crate::{
    domain::config::Config,
    domain::filter::{PROVIDERS, PROVIDERS_KEY, QUALITIES, QUALITY_KEY, SIZE_KEY},
    domain::languages,
    domain::sort::{SORT_KEY, SORT_OPTIONS},
    providers::{
        MOCHS,
        options::{KEY as DEBRID_OPTIONS_KEY, OPTIONS as DEBRID_OPTIONS},
    },
};

const DEFAULT_BACKGROUND: &str = "https://dl.strem.io/addon-background.jpg";
const DEFAULT_LOGO: &str = "https://dl.strem.io/addon-logo.png";
const DEFAULT_VERSION: &str = "0.0.0";
const DEFAULT_DESCRIPTION: &str = "Configuration";
const PUTIO_KEY: &str = "putio";

#[derive(Serialize)]
struct Choice {
    label: String,
    value: &'static str,
}

#[derive(Template)]
#[template(path = "landing.html")]
struct Landing {
    name: String,
    version: String,
    description: String,
    logo: String,
    background: String,
    providers_key: &'static str,
    sort_key: &'static str,
    language_key: &'static str,
    quality_key: &'static str,
    size_key: &'static str,
    debrid_options_key: &'static str,
    saved_providers: String,
    saved_sort: String,
    saved_languages: String,
    saved_quality: String,
    saved_limit: String,
    saved_size: String,
    saved_debrid_provider: String,
    saved_debrid_opts: String,
    api_keys: String,
    putio_client_id: String,
    putio_token: String,
    provider_list: String,
    sort_list: String,
    language_list: String,
    quality_list: String,
    debrid_provider_list: String,
    debrid_opt_list: String,
}

fn script_json<T: Serialize + ?Sized>(value: &T) -> String {
    serde_json::to_string(value)
        .unwrap_or_default()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

fn text(manifest: &Value, key: &str) -> Option<String> {
    manifest[key].as_str().filter(|value| !value.is_empty()).map(str::to_owned)
}

fn split_putio(key: &str) -> (&str, &str) {
    match key.split('@').collect::<Vec<_>>().as_slice() {
        [client_id, token, ..] => (client_id, token),
        _ => ("", ""),
    }
}

pub fn landing(manifest: &Value, config: &Config) -> String {
    let preferences = config.preferences();
    let credentials = config.credentials();
    let saved_providers = preferences
        .providers
        .clone()
        .unwrap_or_else(|| PROVIDERS.iter().map(|provider| provider.key.to_owned()).collect());
    let saved_size = preferences.size_limits.iter().map(|limit| limit.label.as_str()).collect::<Vec<_>>().join(",");
    let saved_limit = preferences.limit.map(|limit| limit.to_string()).unwrap_or_default();
    let saved_qualities: Vec<&str> = preferences.qualities.iter().map(|quality| quality.key()).collect();
    let saved_debrid_provider = MOCHS.iter().find(|moch| credentials.is_set(moch.key)).map_or("none", |moch| moch.key);
    let api_keys: serde_json::Map<String, Value> = MOCHS
        .iter()
        .map(|moch| (moch.key.to_owned(), Value::from(credentials.get(moch.key).unwrap_or_default())))
        .collect();
    let putio = credentials.get(PUTIO_KEY).filter(|key| key.contains('@')).map_or(("", ""), split_putio);

    let providers: Vec<Choice> = PROVIDERS
        .iter()
        .map(|provider| Choice {
            label: provider
                .foreign
                .map_or_else(|| provider.label.to_owned(), |flag| format!("{flag} {}", provider.label)),
            value: provider.key,
        })
        .collect();
    let sorts: Vec<Choice> =
        SORT_OPTIONS.iter().map(|option| Choice { label: option.description.to_owned(), value: option.key }).collect();
    let languages: Vec<Choice> =
        languages::options().into_iter().map(|option| Choice { label: option.label, value: option.key }).collect();
    let qualities: Vec<Choice> =
        QUALITIES.iter().map(|quality| Choice { label: quality.label().to_owned(), value: quality.key() }).collect();
    let debrid_providers: Vec<Choice> =
        MOCHS.iter().map(|moch| Choice { label: moch.name.to_owned(), value: moch.key }).collect();
    let debrid_options: Vec<Choice> = DEBRID_OPTIONS
        .iter()
        .map(|(key, description)| Choice { label: (*description).to_owned(), value: key })
        .collect();

    let page = Landing {
        name: text(manifest, "name").unwrap_or_default(),
        version: text(manifest, "version").unwrap_or_else(|| DEFAULT_VERSION.to_owned()),
        description: text(manifest, "description").unwrap_or_else(|| DEFAULT_DESCRIPTION.to_owned()),
        logo: text(manifest, "logo").unwrap_or_else(|| DEFAULT_LOGO.to_owned()),
        background: text(manifest, "background").unwrap_or_else(|| DEFAULT_BACKGROUND.to_owned()),
        providers_key: PROVIDERS_KEY,
        sort_key: SORT_KEY,
        language_key: languages::CONFIG_KEY,
        quality_key: QUALITY_KEY,
        size_key: SIZE_KEY,
        debrid_options_key: DEBRID_OPTIONS_KEY,
        saved_providers: script_json(&saved_providers),
        saved_sort: script_json(preferences.sort.key()),
        saved_languages: script_json(&preferences.languages),
        saved_quality: script_json(&saved_qualities),
        saved_limit: script_json(&saved_limit),
        saved_size: script_json(&saved_size),
        saved_debrid_provider: script_json(saved_debrid_provider),
        saved_debrid_opts: script_json(&preferences.debrid.keys()),
        api_keys: script_json(&api_keys),
        putio_client_id: script_json(putio.0),
        putio_token: script_json(putio.1),
        provider_list: script_json(&providers),
        sort_list: script_json(&sorts),
        language_list: script_json(&languages),
        quality_list: script_json(&qualities),
        debrid_provider_list: script_json(&debrid_providers),
        debrid_opt_list: script_json(&debrid_options),
    };
    page.render().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn manifest() -> Value {
        json!({ "name": "Torrentio", "version": "0.0.15" })
    }

    fn render(configuration: &str) -> String {
        landing(&manifest(), &Config::parse(configuration))
    }

    #[test]
    fn empty_config_saves_defaults() {
        let html = render("");
        assert!(html.contains("sort: \"quality\","));
        assert!(html.contains("debridProvider: \"none\","));
        assert!(html.contains("limit: \"\","));
        assert!(html.contains("<title>Torrentio - Configuration</title>"));
    }

    #[test]
    fn full_config_saves_every_preference() {
        let html = render(
            "providers=yts,eztv|sort=size|language=portuguese,russian|qualityfilter=480p,scr|sizefilter=5gb,800mb|limit=5|debridoptions=nodownloadlinks,nocatalog|realdebrid=abcDEF123",
        );
        assert!(html.contains("providers: [\"yts\",\"eztv\"],"));
        assert!(html.contains("sort: \"size\","));
        assert!(html.contains("languages: [\"portuguese\",\"russian\"],"));
        assert!(html.contains("qualities: [\"480p\",\"scr\"],"));
        assert!(html.contains("limit: \"5\","));
        assert!(html.contains("sizeFilter: \"5GB,800MB\","));
        assert!(html.contains("debridProvider: \"realdebrid\","));
        assert!(html.contains("debridOpts: [\"nodownloadlinks\",\"nocatalog\"],"));
        assert!(html.contains("\"realdebrid\":\"abcDEF123\""));
    }

    #[test]
    fn putio_key_is_split_into_client_id_and_token() {
        let html = render("putio=123@abc");
        assert!(html.contains("debridProvider: \"putio\","));
        assert!(html.contains("\"123\""));
        assert!(html.contains("\"abc\""));
    }

    #[test]
    fn putio_key_without_separator_leaves_client_id_empty() {
        let html = render("putio=plainkey");
        assert!(html.contains("debridProvider: \"putio\","));
        assert!(html.contains("\"putio\":\"plainkey\""));
    }

    #[test]
    fn presets_use_their_own_saved_values() {
        let lite = render("lite");
        assert!(lite.contains("limit: \"1\","));
        assert!(render("brazuca").contains("languages: [\"portuguese\"],"));
    }

    #[test]
    fn escapes_script_breakout_in_saved_values() {
        let html = render("realdebrid=</script><script>alert(1)</script>");
        assert!(!html.contains("</script><script>alert(1)"));
        assert!(html.contains("\\u003c/script\\u003e"));
    }

    #[test]
    fn escapes_html_in_manifest_text() {
        let html = landing(&json!({ "name": "A<b>&" }), &Config::default());
        assert!(html.contains("<title>A&#60;b&#62;&#38; - Configuration</title>"));
    }

    #[test]
    fn keeps_apostrophes_in_option_labels() {
        assert!(render("").contains("Don't show download to debrid links"));
    }
}
