use std::time::{Duration, Instant};

use async_trait::async_trait;
use log::LevelFilter;
use sqlx::{
    ConnectOptions, PgPool,
    postgres::{PgConnectOptions, PgPoolOptions},
};

use crate::{
    domain::{ContentType, IdQuery, IdRepository, SourceError},
    infrastructure::metrics::Metrics,
};

const MIN_CONNECTIONS: u32 = 1;
const MAX_CONNECTIONS: u32 = 5;
const IDLE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(8);
const SLOW_STATEMENT: Duration = Duration::from_secs(10);
const ID_LIMIT: u32 = 5000;

const EXCLUDED_LANGUAGES_TITLE: &str = r"\m(telugu|tamil|hindi|malayalam|kannada|bengali|marathi|punjabi|tagalog|filipino)\M|[[+(,] *(tel|tam|hin|mal|kan)\M";
const EXCLUDED_LANGUAGES_AUDIO: &str = r"Audio\([^)]*\m(tel|tam|hin|mal|kan|tgl|fil)\M";
const SEASON_TITLE: &str = r"\mS\d{1,2}(E\d+)?\M|\mseason \d|\mcomplete series\M";

#[derive(Clone)]
pub struct Repository {
    pool: PgPool,
    metrics: Metrics,
}

impl Repository {
    pub fn connect(database_url: &str, metrics: Metrics) -> Result<Self, sqlx::Error> {
        let options = database_url
            .parse::<PgConnectOptions>()?
            .log_statements(LevelFilter::Off)
            .log_slow_statements(LevelFilter::Warn, SLOW_STATEMENT);
        let pool = PgPoolOptions::new()
            .min_connections(MIN_CONNECTIONS)
            .max_connections(MAX_CONNECTIONS)
            .idle_timeout(IDLE_TIMEOUT)
            .acquire_timeout(ACQUIRE_TIMEOUT)
            .connect_lazy_with(options);
        Ok(Self { pool, metrics })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }
}

fn sql(query: &IdQuery) -> String {
    let id = if query.kind == ContentType::Anime { "kitsuId" } else { "imdbId" };
    let episode = match query.kind {
        ContentType::Series => r#"AND files."imdbSeason" IS NOT NULL AND files."imdbEpisode" IS NOT NULL"#,
        ContentType::Movie => r#"AND files."imdbSeason" IS NULL AND files."imdbEpisode" IS NULL"#,
        ContentType::Anime => "",
    };
    let date = if query.range.is_some() { r#"AND "uploadDate" BETWEEN $3 AND $4"# } else { "" };
    let title = if query.kind == ContentType::Movie {
        format!(
            r"AND torrents.title NOT LIKE '%[Erotic]%'
         AND torrents.title !~* '{EXCLUDED_LANGUAGES_TITLE}'
         AND coalesce(torrents.languages, '') !~ '{EXCLUDED_LANGUAGES_AUDIO}'
         AND torrents.title !~* '{SEASON_TITLE}'"
        )
    } else {
        String::new()
    };
    let sort = if query.kind == ContentType::Movie { "sum(torrents.seeders)" } else { "max(torrents.seeders)" };
    format!(
        r#"SELECT files."{id}"::text
        FROM (SELECT torrents."infoHash", torrents.seeders FROM torrents
                WHERE seeders > 0 AND type = $1 AND provider = ANY($2) {date} {title}
              ) AS torrents
        JOIN files ON torrents."infoHash" = files."infoHash"
        WHERE files."{id}" IS NOT NULL {episode}
        GROUP BY files."{id}"
        ORDER BY {sort} DESC
        LIMIT {ID_LIMIT}"#
    )
}

#[async_trait]
impl IdRepository for Repository {
    async fn top_ids(&self, query: &IdQuery) -> Result<Vec<String>, SourceError> {
        let sql = sql(query);
        let mut statement =
            sqlx::query_scalar::<_, String>(&sql).persistent(false).bind(query.kind.as_str()).bind(&query.providers);
        if let Some(range) = query.range {
            statement = statement.bind(range.start).bind(range.end);
        }
        let started = Instant::now();
        let ids = statement.fetch_all(&self.pool).await.map_err(|error| SourceError(error.to_string()))?;
        self.metrics.observe_db("SELECT", started.elapsed());
        Ok(ids)
    }

    fn pool_stats(&self) -> (u32, u32) {
        (self.pool.size(), u32::try_from(self.pool.num_idle()).unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::DateRange;

    fn query(kind: ContentType, ranged: bool) -> IdQuery {
        let now = chrono::Utc::now();
        IdQuery { kind, providers: vec!["YTS".to_owned()], range: ranged.then_some(DateRange { start: now, end: now }) }
    }

    #[test]
    fn movies_exclude_foreign_and_season_titles_and_sum_seeders() {
        let sql = sql(&query(ContentType::Movie, true));
        assert!(sql.contains(r#"files."imdbId"::text"#));
        assert!(sql.contains(r#"files."imdbSeason" IS NULL AND files."imdbEpisode" IS NULL"#));
        assert!(sql.contains(r#""uploadDate" BETWEEN $3 AND $4"#));
        assert!(sql.contains("NOT LIKE '%[Erotic]%'"));
        assert!(sql.contains("ORDER BY sum(torrents.seeders) DESC"));
        assert!(sql.ends_with("LIMIT 5000"));
    }

    #[test]
    fn series_require_episodes_and_use_max_seeders() {
        let sql = sql(&query(ContentType::Series, false));
        assert!(sql.contains(r#"files."imdbSeason" IS NOT NULL AND files."imdbEpisode" IS NOT NULL"#));
        assert!(!sql.contains("BETWEEN"));
        assert!(!sql.contains("Erotic"));
        assert!(sql.contains("ORDER BY max(torrents.seeders) DESC"));
    }

    #[test]
    fn anime_groups_by_kitsu_id_without_episode_conditions() {
        let sql = sql(&query(ContentType::Anime, true));
        assert!(sql.contains(r#"GROUP BY files."kitsuId""#));
        assert!(!sql.contains("imdbSeason"));
    }
}
