use crate::{
    domain::config::Config,
    domain::content_type::ContentType,
    domain::stream::Stream,
    domain::title_helper::{extract_provider, extract_size},
};

pub const PROVIDERS_KEY: &str = "providers";
pub const QUALITY_KEY: &str = "qualityfilter";
pub const SIZE_KEY: &str = "sizefilter";

pub struct Provider {
    pub key: &'static str,
    pub label: &'static str,
    pub anime: bool,
    pub foreign: Option<&'static str>,
}

const fn provider(key: &'static str, label: &'static str) -> Provider {
    Provider { key, label, anime: false, foreign: None }
}

const fn anime(key: &'static str, label: &'static str) -> Provider {
    Provider { key, label, anime: true, foreign: None }
}

const fn foreign(key: &'static str, label: &'static str, flag: &'static str) -> Provider {
    Provider { key, label, anime: false, foreign: Some(flag) }
}

pub const PROVIDERS: &[Provider] = &[
    provider("yts", "YTS"),
    provider("eztv", "EZTV"),
    provider("rarbg", "RARBG"),
    provider("1337x", "1337x"),
    provider("ext", "EXT"),
    provider("thepiratebay", "ThePirateBay"),
    provider("kickasstorrents", "KickassTorrents"),
    provider("torrentgalaxy", "TorrentGalaxy"),
    provider("magnetdl", "MagnetDL"),
    anime("horriblesubs", "HorribleSubs"),
    anime("nyaasi", "NyaaSi"),
    anime("tokyotosho", "TokyoTosho"),
    anime("anidex", "AniDex"),
    anime("nekobt", "nekoBT"),
    foreign("rutor", "Rutor", "🇷🇺"),
    foreign("rutracker", "Rutracker", "🇷🇺"),
    foreign("comando", "Comando", "🇵🇹"),
    foreign("bludv", "BluDV", "🇵🇹"),
    foreign("micoleaodublado", "MicoLeaoDublado", "🇵🇹"),
    foreign("torrent9", "Torrent9", "🇫🇷"),
    foreign("ilcorsaronero", "ilCorSaRoNeRo", "🇮🇹"),
    foreign("mejortorrent", "MejorTorrent", "🇪🇸"),
    foreign("wolfmax4k", "Wolfmax4k", "🇪🇸"),
    foreign("cinecalidad", "Cinecalidad", "🇲🇽"),
    foreign("besttorrents", "BestTorrents", "🇵🇱"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
    BrRemux,
    HdrAll,
    DolbyVision,
    DolbyVisionWithHdr,
    ThreeD,
    NonThreeD,
    FourK,
    P1080,
    P720,
    P480,
    Other,
    Screener,
    Cam,
    Unknown,
}

pub const QUALITIES: &[Quality] = &[
    Quality::BrRemux,
    Quality::HdrAll,
    Quality::DolbyVision,
    Quality::DolbyVisionWithHdr,
    Quality::ThreeD,
    Quality::NonThreeD,
    Quality::FourK,
    Quality::P1080,
    Quality::P720,
    Quality::P480,
    Quality::Other,
    Quality::Screener,
    Quality::Cam,
    Quality::Unknown,
];

const OTHER_EXCLUDED: &[&str] = &["4k", "1080p", "720p", "480p", "SCR", "CAM", "TeleSync", "TeleCine"];
const CAM_ITEMS: &[&str] = &["CAM", "TeleSync", "TeleCine"];

impl Quality {
    pub fn key(self) -> &'static str {
        match self {
            Self::BrRemux => "brremux",
            Self::HdrAll => "hdrall",
            Self::DolbyVision => "dolbyvision",
            Self::DolbyVisionWithHdr => "dolbyvisionwithhdr",
            Self::ThreeD => "threed",
            Self::NonThreeD => "nonthreed",
            Self::FourK => "4k",
            Self::P1080 => "1080p",
            Self::P720 => "720p",
            Self::P480 => "480p",
            Self::Other => "other",
            Self::Screener => "scr",
            Self::Cam => "cam",
            Self::Unknown => "unknown",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::BrRemux => "BluRay REMUX",
            Self::HdrAll => "HDR/HDR10+/Dolby Vision",
            Self::DolbyVision => "Dolby Vision",
            Self::DolbyVisionWithHdr => "Dolby Vision + HDR",
            Self::ThreeD => "3D",
            Self::NonThreeD => "Non 3D (DO NOT SELECT IF NOT SURE)",
            Self::FourK => "4k",
            Self::P1080 => "1080p",
            Self::P720 => "720p",
            Self::P480 => "480p",
            Self::Other => "Other (DVDRip/HDRip/BDRip...)",
            Self::Screener => "Screener",
            Self::Cam => "Cam",
            Self::Unknown => "Unknown",
        }
    }

    pub fn matches(self, quality: Option<&str>, binge_group: Option<&str>) -> bool {
        let profiles = || hdr_profiles(quality);
        match self {
            Self::BrRemux => binge_group.is_some_and(|group| group.contains(self.label())),
            Self::HdrAll => {
                let profiles = profiles();
                ["HDR", "HDR10+", "DV"].iter().any(|kind| profiles.contains(kind))
            }
            Self::DolbyVision => profiles() == "DV",
            Self::DolbyVisionWithHdr => {
                let profiles = profiles();
                profiles.contains("DV") && profiles.contains("HDR")
            }
            Self::ThreeD => profiles().contains("3D"),
            Self::NonThreeD => !profiles().contains("3D"),
            Self::FourK => quality.is_some_and(|quality| quality.split(' ').next() == Some("4k")),
            Self::P1080 => quality == Some("1080p"),
            Self::P720 => quality == Some("720p"),
            Self::P480 => quality == Some("480p"),
            Self::Other => quality.is_some_and(|quality| {
                !quality.is_empty() && !OTHER_EXCLUDED.contains(&quality.split(' ').next().unwrap_or_default())
            }),
            Self::Screener => quality == Some("SCR"),
            Self::Cam => quality.is_some_and(|quality| CAM_ITEMS.contains(&quality)),
            Self::Unknown => quality.is_none_or(str::is_empty),
        }
    }
}

fn hdr_profiles(quality: Option<&str>) -> String {
    quality.map(|quality| quality.split(' ').skip(1).collect::<Vec<_>>().join(",")).unwrap_or_default()
}

pub fn apply(streams: &[Stream], config: &Config, content_type: ContentType) -> Vec<Stream> {
    let preferences = config.preferences();
    let providers = preferences.providers.as_deref();
    let size_limit = preferences.size_limit(content_type == ContentType::Movie);
    streams
        .iter()
        .filter(|stream| {
            provider_allowed(&stream.title, providers)
                && !is_excluded(stream, &preferences.qualities)
                && size_limit.is_none_or(|limit| extract_size(&stream.title) <= limit)
        })
        .cloned()
        .collect()
}

fn provider_allowed(title: &str, providers: Option<&[String]>) -> bool {
    let provider = extract_provider(title).unwrap_or_default();
    match providers {
        Some([]) => true,
        Some(keys) => keys.iter().any(|key| key.eq_ignore_ascii_case(provider)),
        None => PROVIDERS.iter().any(|candidate| candidate.key.eq_ignore_ascii_case(provider)),
    }
}

fn is_excluded(stream: &Stream, excluded: &[Quality]) -> bool {
    if excluded.is_empty() {
        return false;
    }
    let quality = stream.name.split('\n').nth(1);
    let binge_group = stream.behavior_hints.as_ref().and_then(|hints| hints.binge_group.as_deref());
    excluded.iter().any(|option| option.matches(quality, binge_group))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn four_k_matches_first_token() {
        assert!(Quality::FourK.matches(Some("4k HDR"), None));
        assert!(!Quality::FourK.matches(Some("1080p"), None));
    }

    #[test]
    fn other_excludes_known_resolutions() {
        assert!(Quality::Other.matches(Some("BluRay"), None));
        assert!(!Quality::Other.matches(Some("1080p HDR"), None));
        assert!(!Quality::Other.matches(None, None));
    }

    #[test]
    fn dolby_vision_requires_exact_profile() {
        assert!(Quality::DolbyVision.matches(Some("4k DV"), None));
        assert!(!Quality::DolbyVision.matches(Some("4k DV HDR"), None));
        assert!(Quality::DolbyVisionWithHdr.matches(Some("4k DV HDR"), None));
    }

    #[test]
    fn unknown_matches_missing_quality() {
        assert!(Quality::Unknown.matches(None, None));
        assert!(!Quality::Unknown.matches(Some("720p"), None));
    }
}
