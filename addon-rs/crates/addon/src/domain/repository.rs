use async_trait::async_trait;

use crate::domain::models::{FileRow, Record, TorrentRow};

#[async_trait]
pub trait TorrentRepository: Send + Sync {
    async fn torrent(&self, info_hash: &str) -> anyhow::Result<Option<TorrentRow>>;

    async fn files(&self, info_hashes: &[String]) -> anyhow::Result<Vec<FileRow>>;

    async fn imdb_movie_entries(&self, imdb_id: &str) -> anyhow::Result<Vec<Record>>;

    async fn imdb_series_entries(&self, imdb_id: &str, season: i32, episode: i32) -> anyhow::Result<Vec<Record>>;

    async fn kitsu_movie_entries(&self, kitsu_id: i32) -> anyhow::Result<Vec<Record>>;

    async fn kitsu_series_entries(&self, kitsu_id: i32, episode: i32) -> anyhow::Result<Vec<Record>>;

    fn pool_stats(&self) -> (u32, u32) {
        (0, 0)
    }
}
