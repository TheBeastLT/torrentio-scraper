use std::{collections::HashMap, future::Future};

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

use crate::{
    domain::models::{FileRow, ItemMeta},
    domain::repository::TorrentRepository,
    domain::stream::Stream,
};

const METAHUB_URL: &str = "https://images.metahub.space";
const MAX_WALK_FOLDERS: usize = 50;
const WALK_CONCURRENCY: usize = 5;
const WILDCARD: u16 = 0xFFFD;

const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

pub fn encode_uri_component(value: &str) -> String {
    utf8_percent_encode(value, COMPONENT).to_string()
}

pub fn stream_filename(stream: &Stream) -> String {
    let filename = stream
        .behavior_hints
        .as_ref()
        .and_then(|hints| hints.filename.as_deref())
        .filter(|filename| !filename.is_empty())
        .map_or_else(|| title_filename(&stream.title), str::to_owned);
    encode_uri_component(&filename)
}

pub fn title_filename(title: &str) -> String {
    let without_stats = title.find("\n👤").map_or(title, |index| &title[..index]);
    let last_line = without_stats.rsplit('\n').next().unwrap_or_default();
    last_line.rsplit('/').next().unwrap_or_default().to_owned()
}

pub fn same_filename(filename: &str, expected: &str) -> bool {
    let filename: Vec<u16> = filename.encode_utf16().collect();
    let expected: Vec<u16> = expected.encode_utf16().collect();
    let offset = filename.len() as isize - expected.len() as isize;
    expected.iter().enumerate().all(|(index, expected)| {
        let actual = usize::try_from(offset + index as isize).ok().and_then(|position| filename.get(position));
        *expected == WILDCARD || actual == Some(expected)
    })
}

pub async fn enrich_meta(repository: &dyn TorrentRepository, mut meta: ItemMeta) -> ItemMeta {
    let mut info_hashes: Vec<String> = Vec::new();
    for info_hash in meta.info_hash.iter().chain(meta.videos.iter().filter_map(|video| video.info_hash.as_ref())) {
        if !info_hashes.contains(info_hash) {
            info_hashes.push(info_hash.clone());
        }
    }
    let files =
        if info_hashes.is_empty() { Vec::new() } else { repository.files(&info_hashes).await.unwrap_or_default() };
    if files.is_empty() {
        return meta;
    }
    let common_imdb_id =
        meta.info_hash.as_ref().and_then(|_| most_common(files.iter().filter_map(|file| file.imdb_id.as_deref())));
    if let Some(imdb_id) = common_imdb_id {
        meta.logo = Some(format!("{METAHUB_URL}/logo/medium/{imdb_id}/img"));
        meta.poster = Some(format!("{METAHUB_URL}/poster/medium/{imdb_id}/img"));
        meta.background = Some(format!("{METAHUB_URL}/background/medium/{imdb_id}/img"));
    }
    let matcher = FileMatcher::new(&files);
    for video in &mut meta.videos {
        let Some(file) = matcher.find(&video.title) else { continue };
        let Some(imdb_id) = file.imdb_id.as_deref().filter(|id| !id.is_empty()) else { continue };
        if let (Some(season), Some(episode)) =
            (file.imdb_season.filter(|season| *season != 0), file.imdb_episode.filter(|episode| *episode != 0))
        {
            video.id = format!("{imdb_id}:{season}:{episode}");
            video.season = Some(season);
            video.episode = Some(episode);
            video.thumbnail = Some(format!("https://episodes.metahub.space/{imdb_id}/{season}/{episode}/w780.jpg"));
        } else {
            video.id = imdb_id.to_owned();
            video.thumbnail = Some(format!("{METAHUB_URL}/background/small/{imdb_id}/img"));
        }
    }
    meta
}

struct FileMatcher<'a> {
    by_title: HashMap<&'a str, &'a FileRow>,
    wildcards: Vec<&'a FileRow>,
}

impl<'a> FileMatcher<'a> {
    fn new(files: &'a [FileRow]) -> Self {
        Self {
            by_title: files.iter().map(|file| (file.title.as_str(), file)).collect(),
            wildcards: files.iter().filter(|file| file.title.contains('\u{FFFD}')).collect(),
        }
    }

    fn find(&self, title: &str) -> Option<&'a FileRow> {
        path_suffixes(title)
            .iter()
            .find_map(|suffix| self.by_title.get(suffix.as_str()).copied())
            .or_else(|| self.wildcards.iter().copied().find(|file| same_filename(title, &file.title)))
    }
}

fn path_suffixes(path: &str) -> Vec<String> {
    let parts: Vec<&str> = path.split('/').collect();
    (0..parts.len()).map(|index| parts[index..].join("/")).collect()
}

fn most_common<'a>(values: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for value in values {
        match counts.iter_mut().find(|(candidate, _)| *candidate == value) {
            Some((_, count)) => *count += 1,
            None => counts.push((value, 1)),
        }
    }
    let mut best: Option<(&str, usize)> = None;
    for entry in counts {
        if best.is_none_or(|(_, count)| entry.1 > count) {
            best = Some(entry);
        }
    }
    best.map(|(value, _)| value)
}

pub struct FolderListing<V> {
    pub folders: Vec<(String, String)>,
    pub videos: Vec<(String, V)>,
}

pub async fn walk_folders<V, E, F, Fut>(root_id: &str, list_folder: F) -> Result<Vec<(String, V)>, E>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<FolderListing<V>, E>>,
{
    let mut files = Vec::new();
    let mut pending: Vec<(String, String)> = vec![(root_id.to_owned(), String::new())];
    let mut listed = 0;
    while !pending.is_empty() && listed < MAX_WALK_FOLDERS {
        let take = pending.len().min(WALK_CONCURRENCY).min(MAX_WALK_FOLDERS - listed);
        let batch: Vec<(String, String)> = pending.drain(..take).collect();
        listed += batch.len();
        let results = futures::future::try_join_all(batch.iter().map(|(id, _)| list_folder(id.clone()))).await?;
        for ((_, prefix), listing) in batch.iter().zip(results) {
            files.extend(listing.videos.into_iter().map(|(name, video)| (format!("{prefix}/{name}"), video)));
            pending.extend(listing.folders.into_iter().map(|(id, name)| (id, format!("{prefix}/{name}"))));
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_filename_matches_suffix() {
        assert!(same_filename("folder/Movie.mkv", "Movie.mkv"));
        assert!(!same_filename("folder/Movie.mkv", "Other.mkv"));
    }

    #[test]
    fn same_filename_supports_wildcards() {
        assert!(same_filename("Movie.mkv", "Mo\u{FFFD}ie.mkv"));
        assert!(!same_filename("short", "a much longer name"));
    }

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_uri_component("a b/c(1)!.mkv"), "a%20b%2Fc(1)!.mkv");
    }

    #[test]
    fn filename_falls_back_to_last_title_line() {
        let stream = Stream { title: "Torrent\nfolder/File.mkv\n👤 5 💾 1 GB".to_owned(), ..Stream::default() };
        assert_eq!(stream_filename(&stream), "File.mkv");
    }

    #[test]
    fn most_common_prefers_first_on_ties() {
        assert_eq!(most_common(["a", "b", "b", "a"].into_iter()), Some("a"));
    }
}
