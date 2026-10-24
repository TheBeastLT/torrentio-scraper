use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorHints {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binge_group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_hash: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl BehaviorHints {
    #[must_use]
    pub fn merged(mut self, other: Option<&BehaviorHints>) -> BehaviorHints {
        let Some(other) = other else {
            return self;
        };
        self.binge_group = other.binge_group.clone().or(self.binge_group);
        self.filename = other.filename.clone().or(self.filename);
        self.video_size = other.video_size.or(self.video_size);
        self.video_hash = other.video_hash.clone().or(self.video_hash);
        self.extra.extend(other.extra.clone());
        self
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stream {
    pub name: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub info_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_idx: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior_hints: Option<BehaviorHints>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct StreamsResponse {
    pub streams: Vec<Stream>,
    #[serde(rename = "cacheMaxAge", skip_serializing_if = "Option::is_none")]
    pub cache_max_age: Option<u32>,
    #[serde(rename = "staleRevalidate", skip_serializing_if = "Option::is_none")]
    pub stale_revalidate: Option<u32>,
    #[serde(rename = "staleError", skip_serializing_if = "Option::is_none")]
    pub stale_error: Option<u32>,
}
