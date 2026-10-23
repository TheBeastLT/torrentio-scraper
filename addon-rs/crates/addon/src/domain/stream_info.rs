use parse_torrent_title::{ParsedTitle, parse};

use crate::{
    domain::content_type::ContentType,
    domain::languages::map_languages,
    domain::models::Record,
    domain::stream::{BehaviorHints, Stream},
    infrastructure::magnet::get_sources,
};

const ADDON_NAME: &str = "Torrentio";
const SIZE_DELTA: f64 = 0.05;
const CAM_SOURCES: &[&str] = &["CAM", "TeleSync", "TeleCine", "SCR"];

pub fn to_stream_info(record: &Record) -> Stream {
    let torrent_info = parse(&record.torrent.title);
    let file_info = parse(&record.title);
    let same_info = same_info(record);
    let quality = quality(record, &torrent_info, &file_info);
    let three_d = file_info.three_d().or_else(|| torrent_info.three_d()).filter(|value| !value.is_empty());
    let hdr_profiles = hdr(&torrent_info).or_else(|| hdr(&file_info)).unwrap_or_default();

    let seeders = record.torrent.seeders.map(|seeders| seeders.to_string());
    let stats = join_parts(
        [
            join_with_prefix(seeders.as_deref(), "👤 ", " "),
            join_with_prefix(format_size(record.size).as_deref(), "💾 ", " "),
            join_with_prefix(Some(record.torrent.provider.as_str()), "⚙️ ", " "),
        ],
        " ",
    );
    let languages = join_parts_vec(&languages(record, &torrent_info, &file_info), " / ");
    let torrent_title = squash_separators(&record.torrent.title);
    let file_title = (!same_info && !record.title.is_empty()).then_some(record.title.as_str());
    let title = join_parts([non_empty(&torrent_title), file_title.map(str::to_owned), stats, languages], "\n")
        .unwrap_or_default();

    let hdr_joined = join_parts_vec(&hdr_profiles, " | ");
    let quality_line = join_parts([quality.clone(), three_d.map(str::to_owned), hdr_joined], " ");
    let name = join_parts([Some(ADDON_NAME.to_owned()), quality_line], "\n").unwrap_or_default();

    let binge_group =
        join_parts_vec(&binge_group_parts(record, same_info, quality.as_deref(), &torrent_info, &file_info), "|")
            .map(|joined| format!("torrentio|{joined}"));
    let filename = record.file_index.map(|_| record.title.rsplit('/').next().unwrap_or_default().to_owned());
    let behavior_hints = (binge_group.is_some() || filename.is_some()).then(|| BehaviorHints {
        binge_group,
        filename,
        ..BehaviorHints::default()
    });

    Stream {
        name,
        title,
        info_hash: Some(record.info_hash.clone()),
        file_idx: record.file_index,
        behavior_hints,
        sources: get_sources(record.torrent.trackers.as_deref(), &record.info_hash),
        url: None,
    }
}

fn same_info(record: &Record) -> bool {
    if record.file_index.is_none() {
        return true;
    }
    let ratio = record.size.unwrap_or(0) as f64 / record.torrent.size.unwrap_or(0) as f64;
    (ratio - 1.0).abs() < SIZE_DELTA || record.title.contains(&record.torrent.title)
}

fn hdr(info: &ParsedTitle) -> Option<Vec<String>> {
    info.hdr().map(<[String]>::to_vec)
}

fn quality(record: &Record, torrent_info: &ParsedTitle, file_info: &ParsedTitle) -> Option<String> {
    for source in [file_info.source(), torrent_info.source()].into_iter().flatten() {
        if CAM_SOURCES.contains(&source) {
            return Some(source.to_owned());
        }
    }
    let resolution = [file_info.resolution(), torrent_info.resolution(), record.torrent.resolution.as_deref()]
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty());
    let source = [file_info.source(), torrent_info.source()].into_iter().flatten().find(|value| !value.is_empty());
    resolution.or(source).map(str::to_owned)
}

fn languages(record: &Record, torrent_info: &ParsedTitle, file_info: &ParsedTitle) -> Vec<String> {
    let provider_languages = record
        .torrent
        .languages
        .as_deref()
        .filter(|languages| !languages.is_empty())
        .map(|languages| parse(&format!("{languages}.srt")).languages().map(<[String]>::to_vec).unwrap_or_default())
        .unwrap_or_default();
    let dubbed = torrent_info.dubbed().unwrap_or(false) || file_info.dubbed().unwrap_or(false);
    let mut languages: Vec<String> = Vec::new();
    for language in torrent_info
        .languages()
        .unwrap_or_default()
        .iter()
        .chain(file_info.languages().unwrap_or_default())
        .chain(&provider_languages)
    {
        if !languages.contains(language) {
            languages.push(language.clone());
        }
    }
    if record.kitsu_id.is_some_and(|id| id != 0) || record.torrent.kind == ContentType::Anime.as_str() {
        if dubbed {
            languages.push("dubbed".to_owned());
        }
        languages.retain(|language| language != "japanese");
    }
    if languages.len() == 1 && languages[0] == "english" {
        languages.clear();
    }
    if languages.is_empty() && dubbed {
        languages = vec!["dubbed".to_owned()];
    }
    map_languages(&languages)
}

fn binge_group_parts(
    record: &Record,
    same_info: bool,
    quality: Option<&str>,
    torrent_info: &ParsedTitle,
    file_info: &ParsedTitle,
) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    if record.torrent.kind == ContentType::Movie.as_str() {
        let source = torrent_info.source().or_else(|| file_info.source()).filter(|value| !value.is_empty());
        parts.extend(quality.map(str::to_owned));
        if let Some(source) = source.filter(|source| Some(*source) != quality) {
            parts.push(source.to_owned());
        }
        parts.extend(torrent_info.codec().or_else(|| file_info.codec()).map(str::to_owned));
        parts.extend(torrent_info.bit_depth().or_else(|| file_info.bit_depth()).map(str::to_owned));
        parts.extend(hdr(torrent_info).or_else(|| hdr(file_info)).unwrap_or_default());
    } else if same_info {
        parts.extend(quality.map(str::to_owned));
        parts.extend(hdr(file_info).unwrap_or_default());
        parts.extend(file_info.group().map(str::to_owned));
    } else {
        parts.push(record.info_hash.clone());
    }
    parts
}

fn squash_separators(title: &str) -> String {
    let mut result = String::with_capacity(title.len());
    let mut in_separator = false;
    for character in title.chars() {
        if character == ',' || character == ' ' {
            if !in_separator {
                result.push(' ');
            }
            in_separator = true;
        } else {
            result.push(character);
            in_separator = false;
        }
    }
    result
}

fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

fn join_with_prefix(part: Option<&str>, prefix: &str, delimiter: &str) -> Option<String> {
    join_parts([part.map(str::to_owned)], delimiter).map(|joined| format!("{prefix}{joined}"))
}

fn join_parts<const N: usize>(parts: [Option<String>; N], delimiter: &str) -> Option<String> {
    let joined = parts.into_iter().flatten().collect::<Vec<_>>().join(delimiter);
    (!joined.is_empty()).then_some(joined)
}

fn join_parts_vec(parts: &[String], delimiter: &str) -> Option<String> {
    let joined = parts.join(delimiter);
    (!joined.is_empty()).then_some(joined)
}

fn format_size(size: Option<i64>) -> Option<String> {
    let size = u128::try_from(size.filter(|size| *size > 0)?).ok()?;
    let exponent = (0..4).take_while(|exponent| size >= 1024u128.pow(exponent + 1)).count() as u32;
    let divisor = 1024u128.pow(exponent);
    let hundredths = (size * 200 + divisor) / (2 * divisor);
    Some(format!("{} {}", hundredths as f64 / 100.0, ["B", "kB", "MB", "GB", "TB"][exponent as usize]))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;
    use crate::domain::models::TorrentRow;

    fn record(title: &str, file_title: &str) -> Record {
        Record {
            info_hash: "abc".to_owned(),
            file_index: Some(1),
            title: file_title.to_owned(),
            size: Some(1_610_612_736),
            kitsu_id: None,
            torrent: TorrentRow {
                info_hash: "abc".to_owned(),
                provider: "ThePirateBay".to_owned(),
                torrent_id: None,
                title: title.to_owned(),
                size: Some(1_610_612_736),
                kind: "movie".to_owned(),
                upload_date: Utc::now(),
                seeders: Some(12),
                trackers: Some("udp://a,udp://b".to_owned()),
                languages: None,
                resolution: None,
            },
        }
    }

    #[test]
    fn builds_name_and_title() {
        let stream =
            to_stream_info(&record("Movie.2020.1080p.BluRay.x264-GRP", "Movie.2020.1080p.BluRay.x264-GRP.mkv"));
        assert_eq!(stream.name, "Torrentio\n1080p");
        assert_eq!(stream.title, "Movie.2020.1080p.BluRay.x264-GRP\n👤 12 💾 1.5 GB ⚙️ ThePirateBay");
        assert_eq!(stream.file_idx, Some(1));
        assert_eq!(stream.sources.as_deref().map(<[String]>::len), Some(3));
    }

    #[test]
    fn movie_binge_group_lists_source_and_codec() {
        let stream =
            to_stream_info(&record("Movie.2020.1080p.BluRay.x264-GRP", "Movie.2020.1080p.BluRay.x264-GRP.mkv"));
        let hints = stream.behavior_hints.unwrap();
        assert_eq!(hints.binge_group.as_deref(), Some("torrentio|1080p|BluRay|x264"));
        assert_eq!(hints.filename.as_deref(), Some("Movie.2020.1080p.BluRay.x264-GRP.mkv"));
    }

    #[test]
    fn formats_sizes() {
        assert_eq!(format_size(Some(1536)).as_deref(), Some("1.5 kB"));
        assert_eq!(format_size(Some(500)).as_deref(), Some("500 B"));
        assert_eq!(format_size(None), None);
    }

    #[test]
    fn rounds_exact_ties_up_like_js() {
        assert_eq!(format_size(Some(260_182_016)).as_deref(), Some("248.13 MB"));
    }

    #[test]
    fn rounds_to_terabytes_at_most() {
        assert_eq!(format_size(Some(3 * 1024_i64.pow(4))).as_deref(), Some("3 TB"));
    }

    #[test]
    fn squashes_commas_and_spaces() {
        assert_eq!(squash_separators("a, b,,c"), "a b c");
    }
}
