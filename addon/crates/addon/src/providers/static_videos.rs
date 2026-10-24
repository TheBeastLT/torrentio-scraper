#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StaticResponse {
    Downloading,
    FailedDownload,
    FailedAccess,
    FailedRar,
    FailedTooBig,
    FailedOpening,
    FailedUnexpected,
    FailedInfringement,
    LimitsExceeded,
    BlockedAccess,
    FailedUnavailable,
}

const ALL: &[StaticResponse] = &[
    StaticResponse::Downloading,
    StaticResponse::FailedDownload,
    StaticResponse::FailedAccess,
    StaticResponse::FailedRar,
    StaticResponse::FailedTooBig,
    StaticResponse::FailedOpening,
    StaticResponse::FailedUnexpected,
    StaticResponse::FailedInfringement,
    StaticResponse::LimitsExceeded,
    StaticResponse::BlockedAccess,
    StaticResponse::FailedUnavailable,
];

impl StaticResponse {
    pub fn path(self) -> &'static str {
        match self {
            Self::Downloading => "videos/downloading_v3.mp4",
            Self::FailedDownload => "videos/download_failed_v3.mp4",
            Self::FailedAccess => "videos/failed_access_v3.mp4",
            Self::FailedRar => "videos/failed_rar_v3.mp4",
            Self::FailedTooBig => "videos/failed_too_big_v2.mp4",
            Self::FailedOpening => "videos/failed_opening_v3.mp4",
            Self::FailedUnexpected => "videos/failed_unexpected_v3.mp4",
            Self::FailedInfringement => "videos/failed_infringement_v3.mp4",
            Self::LimitsExceeded => "videos/limits_exceeded_v2.mp4",
            Self::BlockedAccess => "videos/blocked_access_v2.mp4",
            Self::FailedUnavailable => "videos/failed_unavailable_v1.mp4",
        }
    }

    pub fn outcome(self) -> &'static str {
        match self {
            Self::Downloading => "downloading",
            Self::FailedDownload => "failed_download",
            Self::FailedAccess => "failed_access",
            Self::FailedRar => "failed_rar",
            Self::FailedTooBig => "failed_too_big",
            Self::FailedOpening => "failed_opening",
            Self::FailedUnexpected => "failed_unexpected",
            Self::FailedInfringement => "failed_infringement",
            Self::LimitsExceeded => "limits_exceeded",
            Self::BlockedAccess => "blocked_access",
            Self::FailedUnavailable => "failed_unavailable",
        }
    }

    pub fn from_url(url: &str) -> Option<Self> {
        ALL.iter().copied().find(|response| url.ends_with(response.path()))
    }
}

pub fn is_static_url(url: &str) -> bool {
    StaticResponse::from_url(url).is_some()
}
