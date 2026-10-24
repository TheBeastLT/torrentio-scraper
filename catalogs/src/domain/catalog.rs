use chrono::{DateTime, Datelike, Days, NaiveDate, TimeDelta, Utc};

pub const GENRES: [&str; 6] = ["Yesterday", "This Week", "Last Week", "This Month", "Last Month", "All Time"];

pub const DEFAULT_PROVIDERS: [&str; 14] = [
    "1337x",
    "AniDex",
    "EXT",
    "EZTV",
    "HorribleSubs",
    "KickassTorrents",
    "MagnetDL",
    "NyaaSi",
    "RARBG",
    "ThePirateBay",
    "TokyoTosho",
    "TorrentGalaxy",
    "YTS",
    "nekoBT",
];

pub const DEFAULT_GENRE: &str = "default";

pub fn normalize_genre(genre: &str) -> &str {
    if GENRES.contains(&genre) { genre } else { DEFAULT_GENRE }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentType {
    Movie,
    Series,
    Anime,
}

impl ContentType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
            Self::Anime => "anime",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Catalog {
    pub id: &'static str,
    pub kind: ContentType,
    pub name: &'static str,
    pub page_size: usize,
}

pub const CATALOGS: [Catalog; 3] = [
    Catalog { id: "top-movies", kind: ContentType::Movie, name: "Top seeded", page_size: 20 },
    Catalog { id: "top-series", kind: ContentType::Series, name: "Top seeded", page_size: 20 },
    Catalog { id: "top-anime", kind: ContentType::Anime, name: "Top seeded", page_size: 20 },
];

pub fn find_catalog(id: &str) -> Option<&'static Catalog> {
    CATALOGS.iter().find(|catalog| catalog.id == id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DateRange {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

pub fn date_range(genre: &str, now: DateTime<Utc>) -> Option<DateRange> {
    let days = |count: u64| now - TimeDelta::days(count as i64);
    let [yesterday, this_week, last_week, this_month, last_month, all_time] = GENRES;
    match genre {
        _ if genre == yesterday => Some(day(days(1))),
        _ if genre == this_week => Some(week(now)),
        _ if genre == last_week => Some(week(days(7))),
        _ if genre == this_month => Some(month(now)),
        _ if genre == last_month => Some(month(days(30))),
        _ if genre == all_time => None,
        _ => Some(DateRange { start: day(days(30)).start, end: day(days(1)).end }),
    }
}

fn midnight(date: NaiveDate) -> DateTime<Utc> {
    date.and_time(chrono::NaiveTime::MIN).and_utc()
}

fn range(first: NaiveDate, next: NaiveDate) -> DateRange {
    DateRange { start: midnight(first), end: midnight(next) - TimeDelta::milliseconds(1) }
}

fn day(moment: DateTime<Utc>) -> DateRange {
    let first = moment.date_naive();
    range(first, first + Days::new(1))
}

fn week(moment: DateTime<Utc>) -> DateRange {
    let first = moment.date_naive() - Days::new(u64::from(moment.weekday().num_days_from_monday()));
    range(first, first + Days::new(7))
}

fn month(moment: DateTime<Utc>) -> DateRange {
    let first = moment.date_naive().with_day(1).unwrap_or_else(|| moment.date_naive());
    range(first, first + chrono::Months::new(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }

    fn bounds(genre: &str, now: &str) -> Option<(String, String)> {
        date_range(genre, at(now)).map(|range| {
            let format = "%Y-%m-%dT%H:%M:%S%.3fZ";
            (range.start.format(format).to_string(), range.end.format(format).to_string())
        })
    }

    fn pair(start: &str, end: &str) -> (String, String) {
        (start.to_owned(), end.to_owned())
    }

    #[test]
    fn yesterday_is_the_previous_utc_day() {
        assert_eq!(
            bounds("Yesterday", "2026-10-24T13:45:10Z"),
            Some(pair("2026-10-23T00:00:00.000Z", "2026-10-23T23:59:59.999Z"))
        );
    }

    #[test]
    fn this_week_runs_monday_to_sunday() {
        assert_eq!(
            bounds("This Week", "2026-10-24T13:45:10Z"),
            Some(pair("2026-10-19T00:00:00.000Z", "2026-10-25T23:59:59.999Z"))
        );
        assert_eq!(
            bounds("This Week", "2026-10-19T00:00:00Z"),
            Some(pair("2026-10-19T00:00:00.000Z", "2026-10-25T23:59:59.999Z"))
        );
        assert_eq!(
            bounds("This Week", "2026-10-25T23:59:59Z"),
            Some(pair("2026-10-19T00:00:00.000Z", "2026-10-25T23:59:59.999Z"))
        );
    }

    #[test]
    fn last_week_is_seven_days_back() {
        assert_eq!(
            bounds("Last Week", "2026-10-24T13:45:10Z"),
            Some(pair("2026-10-12T00:00:00.000Z", "2026-10-18T23:59:59.999Z"))
        );
    }

    #[test]
    fn this_month_spans_the_calendar_month() {
        assert_eq!(
            bounds("This Month", "2026-02-10T00:00:00Z"),
            Some(pair("2026-02-01T00:00:00.000Z", "2026-02-28T23:59:59.999Z"))
        );
        assert_eq!(
            bounds("This Month", "2026-12-31T23:00:00Z"),
            Some(pair("2026-12-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z"))
        );
    }

    #[test]
    fn last_month_goes_back_thirty_days_before_snapping_to_the_month() {
        assert_eq!(
            bounds("Last Month", "2026-10-24T13:45:10Z"),
            Some(pair("2026-09-01T00:00:00.000Z", "2026-09-30T23:59:59.999Z"))
        );
        assert_eq!(
            bounds("Last Month", "2026-10-31T13:45:10Z"),
            Some(pair("2026-10-01T00:00:00.000Z", "2026-10-31T23:59:59.999Z"))
        );
    }

    #[test]
    fn all_time_has_no_bounds() {
        assert_eq!(bounds("All Time", "2026-10-24T13:45:10Z"), None);
    }

    #[test]
    fn unknown_genres_cover_the_last_thirty_days_up_to_yesterday() {
        let expected = Some(pair("2026-09-24T00:00:00.000Z", "2026-10-23T23:59:59.999Z"));
        assert_eq!(bounds("default", "2026-10-24T13:45:10Z"), expected);
        assert_eq!(bounds("Whatever", "2026-10-24T13:45:10Z"), expected);
    }

    #[test]
    fn unknown_genres_normalize_to_the_default() {
        assert_eq!(normalize_genre("Bogus"), "default");
        assert_eq!(normalize_genre("default"), "default");
        assert_eq!(normalize_genre("This Week"), "This Week");
        assert_eq!(normalize_genre("all time"), "default");
    }

    #[test]
    fn finds_catalogs_by_id_only() {
        assert_eq!(find_catalog("top-anime").map(|catalog| catalog.kind), Some(ContentType::Anime));
        assert!(find_catalog("top-tv").is_none());
    }

    #[test]
    fn default_providers_are_sorted() {
        let mut sorted = DEFAULT_PROVIDERS;
        sorted.sort_unstable();
        assert_eq!(sorted, DEFAULT_PROVIDERS);
    }
}
