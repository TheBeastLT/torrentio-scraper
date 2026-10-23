use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use log::LevelFilter;
use sqlx::{
    ConnectOptions, FromRow, PgPool, Postgres,
    pool::PoolConnection,
    postgres::{PgConnectOptions, PgPoolOptions},
};

use crate::{
    domain::{
        models::{FileRow, Record, TorrentRow},
        repository::TorrentRepository,
    },
    infrastructure::metrics::Metrics,
};

const MIN_CONNECTIONS: u32 = 5;
const MAX_CONNECTIONS: u32 = 30;
const IDLE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const SLOW_STATEMENT: Duration = Duration::from_secs(2);

macro_rules! entries_sql {
    ($condition:literal) => {
        concat!(
            r#"SELECT
    f."infoHash" AS f_info_hash, f."fileIndex" AS f_file_index, f."title" AS f_title, f."size" AS f_size,
    f."kitsuId" AS f_kitsu_id,
    t."infoHash" AS t_info_hash, t."provider" AS t_provider, t."torrentId" AS t_torrent_id, t."title" AS t_title,
    t."size" AS t_size, t."type" AS t_type, t."uploadDate" AS t_upload_date, t."seeders" AS t_seeders,
    t."trackers" AS t_trackers, t."languages" AS t_languages, t."resolution" AS t_resolution
    FROM "files" AS f LEFT OUTER JOIN "torrents" AS t ON f."infoHash" = t."infoHash"
    WHERE "#,
            $condition,
            r#" ORDER BY t."seeders" DESC LIMIT 500"#
        )
    };
}

const IMDB_MOVIE_SQL: &str = entries_sql!(r#"f."imdbId" = $1"#);
const IMDB_SERIES_SQL: &str = entries_sql!(r#"f."imdbId" = $1 AND f."imdbSeason" = $2 AND f."imdbEpisode" = $3"#);
const KITSU_MOVIE_SQL: &str = entries_sql!(r#"f."kitsuId" = $1"#);
const KITSU_SERIES_SQL: &str = entries_sql!(r#"f."kitsuId" = $1 AND f."kitsuEpisode" = $2"#);

const TORRENT_SQL: &str = r#"SELECT "infoHash" AS info_hash, "provider", "torrentId" AS torrent_id, "title", "size",
       "type" AS kind, "uploadDate" AS upload_date, "seeders", "trackers", "languages", "resolution"
FROM "torrents" WHERE "infoHash" = $1 LIMIT 1"#;
const FILES_SQL: &str =
    r#"SELECT "infoHash", "title", "imdbId", "imdbSeason", "imdbEpisode" FROM "files" WHERE "infoHash" = ANY($1)"#;

#[derive(FromRow)]
struct TorrentColumns {
    info_hash: String,
    provider: String,
    torrent_id: Option<String>,
    title: String,
    size: Option<i64>,
    kind: String,
    upload_date: DateTime<Utc>,
    seeders: Option<i16>,
    trackers: Option<String>,
    languages: Option<String>,
    resolution: Option<String>,
}

impl From<TorrentColumns> for TorrentRow {
    fn from(columns: TorrentColumns) -> Self {
        Self {
            info_hash: columns.info_hash,
            provider: columns.provider,
            torrent_id: columns.torrent_id,
            title: columns.title,
            size: columns.size,
            kind: columns.kind,
            upload_date: columns.upload_date,
            seeders: columns.seeders,
            trackers: columns.trackers,
            languages: columns.languages,
            resolution: columns.resolution,
        }
    }
}

#[derive(FromRow)]
struct FileColumns {
    #[sqlx(rename = "infoHash")]
    info_hash: String,
    title: String,
    #[sqlx(rename = "imdbId")]
    imdb_id: Option<String>,
    #[sqlx(rename = "imdbSeason")]
    imdb_season: Option<i32>,
    #[sqlx(rename = "imdbEpisode")]
    imdb_episode: Option<i32>,
}

#[derive(FromRow)]
struct RecordColumns {
    f_info_hash: String,
    f_file_index: Option<i32>,
    f_title: String,
    f_size: Option<i64>,
    f_kitsu_id: Option<i32>,
    t_info_hash: Option<String>,
    t_provider: Option<String>,
    t_torrent_id: Option<String>,
    t_title: Option<String>,
    t_size: Option<i64>,
    t_type: Option<String>,
    t_upload_date: Option<DateTime<Utc>>,
    t_seeders: Option<i16>,
    t_trackers: Option<String>,
    t_languages: Option<String>,
    t_resolution: Option<String>,
}

impl RecordColumns {
    fn into_record(self) -> Option<Record> {
        let torrent = TorrentColumns {
            info_hash: self.t_info_hash?,
            provider: self.t_provider?,
            torrent_id: self.t_torrent_id,
            title: self.t_title?,
            size: self.t_size,
            kind: self.t_type?,
            upload_date: self.t_upload_date?,
            seeders: self.t_seeders,
            trackers: self.t_trackers,
            languages: self.t_languages,
            resolution: self.t_resolution,
        };
        Some(Record {
            info_hash: self.f_info_hash,
            file_index: self.f_file_index,
            title: self.f_title,
            size: self.f_size,
            kitsu_id: self.f_kitsu_id,
            torrent: torrent.into(),
        })
    }
}

#[derive(Clone)]
pub struct Repository {
    pool: PgPool,
    metrics: Metrics,
}

type Result<T> = std::result::Result<T, sqlx::Error>;

type Query<'q, O> = sqlx::query::QueryAs<'q, Postgres, O, sqlx::postgres::PgArguments>;

impl Repository {
    pub fn connect(database_url: &str, metrics: Metrics) -> Result<Self> {
        let options = database_url
            .parse::<PgConnectOptions>()?
            .log_statements(LevelFilter::Off)
            .log_slow_statements(LevelFilter::Warn, SLOW_STATEMENT);
        let pool = PgPoolOptions::new()
            .min_connections(MIN_CONNECTIONS)
            .max_connections(MAX_CONNECTIONS)
            .idle_timeout(IDLE_TIMEOUT)
            .connect_lazy_with(options);
        Ok(Self { pool, metrics })
    }

    pub fn pool_stats(&self) -> (u32, u32) {
        (self.pool.size(), u32::try_from(self.pool.num_idle()).unwrap_or(0))
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    async fn connection(&self) -> Result<PoolConnection<Postgres>> {
        let _waiting = self.metrics.pool_waiting();
        self.pool.acquire().await
    }

    async fn fetch_all<'q, O>(&self, query: Query<'q, O>) -> Result<Vec<O>>
    where
        O: for<'r> FromRow<'r, sqlx::postgres::PgRow> + Send + Unpin,
    {
        let mut connection = self.connection().await?;
        let started = Instant::now();
        let rows = query.fetch_all(&mut *connection).await?;
        self.metrics.observe_db("SELECT", started.elapsed());
        Ok(rows)
    }

    async fn entries(&self, query: Query<'_, RecordColumns>) -> Result<Vec<Record>> {
        Ok(self.fetch_all(query).await?.into_iter().filter_map(RecordColumns::into_record).collect())
    }
}

#[async_trait]
impl TorrentRepository for Repository {
    async fn torrent(&self, info_hash: &str) -> anyhow::Result<Option<TorrentRow>> {
        let rows = self.fetch_all(sqlx::query_as::<_, TorrentColumns>(TORRENT_SQL).bind(info_hash)).await?;
        Ok(rows.into_iter().next().map(TorrentRow::from))
    }

    async fn files(&self, info_hashes: &[String]) -> anyhow::Result<Vec<FileRow>> {
        let rows = self.fetch_all(sqlx::query_as::<_, FileColumns>(FILES_SQL).bind(info_hashes)).await?;
        Ok(rows
            .into_iter()
            .map(|row| FileRow {
                info_hash: row.info_hash,
                title: row.title,
                imdb_id: row.imdb_id,
                imdb_season: row.imdb_season,
                imdb_episode: row.imdb_episode,
            })
            .collect())
    }

    async fn imdb_movie_entries(&self, imdb_id: &str) -> anyhow::Result<Vec<Record>> {
        Ok(self.entries(sqlx::query_as(IMDB_MOVIE_SQL).bind(imdb_id)).await?)
    }

    async fn imdb_series_entries(&self, imdb_id: &str, season: i32, episode: i32) -> anyhow::Result<Vec<Record>> {
        Ok(self.entries(sqlx::query_as(IMDB_SERIES_SQL).bind(imdb_id).bind(season).bind(episode)).await?)
    }

    async fn kitsu_movie_entries(&self, kitsu_id: i32) -> anyhow::Result<Vec<Record>> {
        Ok(self.entries(sqlx::query_as(KITSU_MOVIE_SQL).bind(kitsu_id)).await?)
    }

    async fn kitsu_series_entries(&self, kitsu_id: i32, episode: i32) -> anyhow::Result<Vec<Record>> {
        Ok(self.entries(sqlx::query_as(KITSU_SERIES_SQL).bind(kitsu_id).bind(episode)).await?)
    }

    fn pool_stats(&self) -> (u32, u32) {
        Repository::pool_stats(self)
    }
}
