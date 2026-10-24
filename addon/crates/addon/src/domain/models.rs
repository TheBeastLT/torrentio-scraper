use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct TorrentRow {
    pub info_hash: String,
    pub provider: String,
    pub torrent_id: Option<String>,
    pub title: String,
    pub size: Option<i64>,
    pub kind: String,
    pub upload_date: DateTime<Utc>,
    pub seeders: Option<i16>,
    pub trackers: Option<String>,
    pub languages: Option<String>,
    pub resolution: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Record {
    pub info_hash: String,
    pub file_index: Option<i32>,
    pub title: String,
    pub size: Option<i64>,
    pub kitsu_id: Option<i32>,
    pub torrent: TorrentRow,
}

#[derive(Clone, Debug)]
pub struct FileRow {
    pub info_hash: String,
    pub title: String,
    pub imdb_id: Option<String>,
    pub imdb_season: Option<i32>,
    pub imdb_episode: Option<i32>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CatalogMeta {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct VideoStream {
    pub url: String,
    #[serde(default, rename = "behaviorHints", skip_serializing_if = "Option::is_none")]
    pub behavior_hints: Option<crate::domain::stream::BehaviorHints>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Video {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released: Option<String>,
    #[serde(default, rename = "infoHash", skip_serializing_if = "Option::is_none")]
    pub info_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub streams: Vec<VideoStream>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ItemMeta {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, rename = "infoHash", skip_serializing_if = "Option::is_none")]
    pub info_hash: Option<String>,
    #[serde(default)]
    pub videos: Vec<Video>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default, rename = "noCache", skip_serializing_if = "std::ops::Not::not")]
    pub no_cache: bool,
}
