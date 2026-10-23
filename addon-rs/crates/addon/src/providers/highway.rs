use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use debrid::highway::{Client, File, request_failed_message};
use futures::future::join_all;

use super::{
    CachedStreams, CommonError, Context, Moch, MochError, MochResult, ResolveParams, Resolved,
    helper::same_filename,
    static_videos::StaticResponse,
    support::{
        CachedName, Rule, adding_error, build_cached, index_text, info_hashes, quoted, resolve_target, static_or_err,
    },
};
use crate::{
    domain::config::Config,
    domain::extension::{is_archive, is_video},
    domain::models::{CatalogMeta, ItemMeta},
    domain::stream::Stream,
};

const CHUNK_SIZE: usize = 100;

struct HighWay {
    client: Client,
}

#[allow(clippy::needless_pass_by_value)]
pub fn build(context: Arc<Context>) -> Box<dyn Moch> {
    let client = match context.endpoints.highway.as_ref().filter(|base| !base.is_empty()) {
        Some(base) => Client::with_base_url(context.http.clone(), base.clone()),
        None => Client::new(context.http.clone()),
    };
    Box::new(HighWay { client })
}

#[async_trait]
impl Moch for HighWay {
    async fn cached_streams(
        &self,
        streams: &[Stream],
        api_key: &str,
        _ip: Option<&str>,
    ) -> MochResult<Option<CachedStreams>> {
        let chunks = streams.chunks(CHUNK_SIZE).map(|chunk| self.chunk_streams(api_key, chunk));
        let mut all = HashMap::new();
        for result in join_all(chunks).await {
            all.extend(result?);
        }
        Ok(Some(all))
    }

    async fn catalog(&self, _api_key: &str, _catalog_id: &str, _config: &Config) -> MochResult<Vec<CatalogMeta>> {
        Ok(Vec::new())
    }

    async fn item_meta(&self, _item_id: &str, _api_key: &str, _ip: Option<&str>) -> MochResult<ItemMeta> {
        Err(CommonError::NotFound.into())
    }

    async fn resolve(&self, params: &ResolveParams) -> MochResult<Resolved> {
        self.add_and_resolve(params).await.or_else(|error| {
            let rules =
                [Rule::new(is_access_denied(&error), StaticResponse::FailedAccess, "Access denied to HighWay {}")];
            static_or_err(&rules, &resolve_target(params), || adding_error("HighWay", quoted(error_message(&error))))
        })
    }

    fn to_common_error(&self, error: &MochError) -> Option<CommonError> {
        common_error(error)
    }
}

impl HighWay {
    async fn chunk_streams(&self, api_key: &str, streams: &[Stream]) -> MochResult<CachedStreams> {
        let results = match self.client.check(api_key, &info_hashes(streams)).await {
            Ok(response) => response.results,
            Err(error) => {
                let error = MochError::from(error);
                if common_error(&error).is_some() {
                    return Err(error);
                }
                tracing::warn!(moch = "highway", error = %error_message(&error), "Failed HighWay cached torrent availability request");
                HashMap::new()
            }
        };
        Ok(build_cached(api_key, streams, CachedName::Filename, |_, _, info_hash| {
            results.get(&info_hash.to_lowercase()).is_some_and(|entry| entry.known && entry.ready)
        }))
    }

    async fn add_and_resolve(&self, params: &ResolveParams) -> MochResult<Resolved> {
        let api_key = params.api_key.as_str();
        let info_hash = params.info_hash.as_str();
        let added = self.client.add(api_key, info_hash).await?;
        if added.state != "completed" {
            tracing::info!(moch = "highway", %info_hash, file_index = %index_text(params.file_index), "Downloading to HighWay");
            return Ok(StaticResponse::Downloading.into());
        }
        let status = self.client.status(api_key, &added.id, &added.service).await?;
        let videos = sorted_videos(&status.files);
        let target = target_video(&videos, params.file_index, &params.cached_entry_info);
        if target.is_none() && videos.iter().all(|video| is_archive(&video.path)) {
            tracing::info!(
                moch = "highway",
                %info_hash,
                file_index = %index_text(params.file_index),
                "Only HighWay archive is available"
            );
            return Ok(StaticResponse::FailedRar.into());
        }
        match target.and_then(|video| video.download_url.clone()).filter(|url| !url.is_empty()) {
            Some(url) => Ok(Resolved::Url(url)),
            None => Err(MochError::message(format!("No download_url for HighWay {}", resolve_target(params)))),
        }
    }
}

fn sorted_videos(files: &[File]) -> Vec<&File> {
    let mut videos: Vec<&File> = files.iter().filter(|file| is_video(&file.path)).collect();
    videos.sort_by(|a, b| b.size.total_cmp(&a.size));
    videos
}

fn target_video<'a>(videos: &[&'a File], file_index: Option<i64>, target_file_name: &str) -> Option<&'a File> {
    file_index
        .and_then(|_| videos.iter().find(|video| same_filename(&video.path, target_file_name)).copied())
        .or_else(|| videos.first().copied())
}

fn status_of(error: &MochError) -> Option<u16> {
    error.provider().and_then(debrid::Error::status)
}

fn is_access_denied(error: &MochError) -> bool {
    status_of(error) == Some(403)
}

fn common_error(error: &MochError) -> Option<CommonError> {
    match error {
        MochError::Common(common) => Some(*common),
        _ => match status_of(error) {
            Some(401) => Some(CommonError::BadToken),
            Some(403) => Some(CommonError::AccessDenied),
            _ => None,
        },
    }
}

fn error_message(error: &MochError) -> String {
    match status_of(error) {
        Some(status) => request_failed_message(status),
        None => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn http_error(status: u16) -> MochError {
        debrid::Error::api(Some(status), json!(null)).into()
    }

    fn video(path: &str, size: f64) -> File {
        File { path: path.to_owned(), size, download_url: Some(format!("https://dl/{path}")) }
    }

    #[test]
    fn unauthorized_is_bad_token() {
        assert_eq!(common_error(&http_error(401)), Some(CommonError::BadToken));
    }

    #[test]
    fn forbidden_is_access_denied() {
        assert_eq!(common_error(&http_error(403)), Some(CommonError::AccessDenied));
        assert!(is_access_denied(&http_error(403)));
    }

    #[test]
    fn other_statuses_are_not_common_errors() {
        assert_eq!(common_error(&http_error(500)), None);
        assert_eq!(common_error(&MochError::message("boom")), None);
        assert!(!is_access_denied(&http_error(401)));
    }

    #[test]
    fn error_messages_mirror_the_node_request_failure() {
        assert_eq!(error_message(&http_error(502)), "HighWay API request failed: 502");
        assert_eq!(quoted(error_message(&http_error(502))), "\"HighWay API request failed: 502\"");
    }

    #[test]
    fn videos_are_sorted_by_size_descending_and_exclude_other_files() {
        let files = vec![video("a.mkv", 1.0), video("readme.txt", 99.0), video("b.mkv", 5.0)];
        let paths: Vec<&str> = sorted_videos(&files).iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, vec!["b.mkv", "a.mkv"]);
    }

    #[test]
    fn target_matches_the_filename_when_an_index_is_given() {
        let files = vec![video("dir/big.mkv", 9.0), video("dir/small.mkv", 1.0)];
        let videos = sorted_videos(&files);
        assert_eq!(target_video(&videos, Some(1), "small.mkv").map(|file| file.path.as_str()), Some("dir/small.mkv"));
    }

    #[test]
    fn target_falls_back_to_the_largest_video() {
        let files = vec![video("dir/big.mkv", 9.0), video("dir/small.mkv", 1.0)];
        let videos = sorted_videos(&files);
        assert_eq!(target_video(&videos, Some(1), "missing.mkv").map(|file| file.path.as_str()), Some("dir/big.mkv"));
        assert_eq!(target_video(&videos, None, "small.mkv").map(|file| file.path.as_str()), Some("dir/big.mkv"));
    }

    #[test]
    fn no_videos_yields_no_target() {
        assert!(target_video(&[], Some(0), "a.mkv").is_none());
    }
}
