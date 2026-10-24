use std::sync::LazyLock;

use regex::Regex;

const VIDEO: &[&str] = &[
    "3g2", "3gp", "avi", "flv", "mkv", "mk3d", "mov", "mp2", "mp4", "m4v", "mpe", "mpeg", "mpg", "mpv", "webm", "wmv",
    "ogm", "ts", "mts", "m2ts",
];
const ARCHIVE: &[&str] = &["rar", "zip"];

static EXTENSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.([A-Za-z0-9_]{2,4})$").expect("valid regex"));

pub fn is_video(filename: &str) -> bool {
    has_extension(filename, VIDEO)
}

pub fn is_archive(filename: &str) -> bool {
    has_extension(filename, ARCHIVE)
}

pub fn has_extension(filename: &str, extensions: &[&str]) -> bool {
    EXTENSION.captures(filename).is_some_and(|captures| extensions.contains(&captures[1].to_ascii_lowercase().as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_video_files() {
        assert!(is_video("Movie.2020.1080p.MKV"));
        assert!(!is_video("Movie.2020.nfo"));
        assert!(!is_video("noextension"));
    }

    #[test]
    fn detects_archives() {
        assert!(is_archive("release.rar"));
        assert!(!is_archive("release.mkv"));
    }
}
