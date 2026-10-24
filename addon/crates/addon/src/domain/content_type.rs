use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentType {
    Movie,
    Series,
    Anime,
    Other,
}

impl ContentType {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "movie" => Some(Self::Movie),
            "series" => Some(Self::Series),
            "anime" => Some(Self::Anime),
            "other" => Some(Self::Other),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
            Self::Anime => "anime",
            Self::Other => "other",
        }
    }
}
