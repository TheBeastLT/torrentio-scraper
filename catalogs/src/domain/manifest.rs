use serde_json::{Value, json};

use super::catalog::{CATALOGS, GENRES};

pub fn manifest() -> Value {
    let catalogs: Vec<Value> = CATALOGS
        .iter()
        .map(|catalog| {
            json!({
                "id": catalog.id,
                "type": catalog.kind.as_str(),
                "name": catalog.name,
                "pageSize": catalog.page_size,
                "extra": [{ "name": "genre", "options": GENRES }, { "name": "skip" }],
                "genres": GENRES,
            })
        })
        .collect();
    json!({
        "id": "com.stremio.torrentio.catalog.addon",
        "version": "1.0.2",
        "name": "Torrent Catalogs",
        "description": "Provides catalogs for movies/series/anime based on top seeded torrents. Requires Kitsu addon for anime.",
        "logo": "https://i.ibb.co/w4BnkC9/GwxAcDV.png",
        "background": "https://i.ibb.co/VtSfFP9/t8wVwcg.jpg",
        "types": ["movie", "series", "anime"],
        "resources": ["catalog"],
        "catalogs": catalogs,
        "behaviorHints": { "configurable": false, "configurationRequired": false },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_one_catalog_per_content_type() {
        let manifest = manifest();
        let ids: Vec<&str> =
            manifest["catalogs"].as_array().unwrap().iter().map(|catalog| catalog["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["top-movies", "top-series", "top-anime"]);
        assert_eq!(manifest["catalogs"][2]["type"], "anime");
        assert_eq!(manifest["catalogs"][0]["extra"][0]["options"][5], "All Time");
    }

    #[test]
    fn is_not_configurable() {
        assert_eq!(manifest()["behaviorHints"]["configurable"], false);
    }
}
