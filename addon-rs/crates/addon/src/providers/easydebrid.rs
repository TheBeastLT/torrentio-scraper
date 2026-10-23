use std::sync::Arc;

use async_trait::async_trait;
use debrid::easydebrid::{Client, File};

use super::{
    CachedStreams, CommonError, Context, Moch, MochError, MochResult, ResolveParams, Resolved,
    helper::same_filename,
    static_videos::StaticResponse,
    support::{
        CachedName, Rule, adding_error, build_cached, error_text, index_text, padded_info_hashes, quoted,
        resolve_target, static_or_err,
    },
};
use crate::{
    domain::config::Config,
    domain::extension::is_video,
    domain::models::{CatalogMeta, ItemMeta},
    domain::stream::Stream,
    infrastructure::magnet::encode_magnet,
};

const NOT_LOGGED_IN: &str = "Not logged in.";
const NOT_PREMIUM: &str = "Account not premium.";

struct EasyDebrid {
    client: Client,
}

#[allow(clippy::needless_pass_by_value)]
pub fn build(context: Arc<Context>) -> Box<dyn Moch> {
    Box::new(EasyDebrid { client: Client::new(context.http.clone()) })
}

#[async_trait]
impl Moch for EasyDebrid {
    async fn cached_streams(
        &self,
        streams: &[Stream],
        api_key: &str,
        _ip: Option<&str>,
    ) -> MochResult<Option<CachedStreams>> {
        let flags = match self.client.link_lookup(api_key, &padded_info_hashes(streams)).await {
            Ok(lookup) => lookup.cached,
            Err(error) => {
                let error = MochError::from(error);
                if common_error(&error).is_some() {
                    return Err(error);
                }
                tracing::warn!(moch = "easydebrid", error = %easydebrid_text(&error), "Failed EasyDebrid cached torrent availability request");
                Vec::new()
            }
        };
        let cached = build_cached(api_key, streams, CachedName::Filename, |position, _, _| {
            flags.get(position).copied().unwrap_or(false)
        });
        Ok(Some(cached))
    }

    async fn catalog(&self, _api_key: &str, _catalog_id: &str, _config: &Config) -> MochResult<Vec<CatalogMeta>> {
        Ok(Vec::new())
    }

    async fn item_meta(&self, _item_id: &str, _api_key: &str, _ip: Option<&str>) -> MochResult<ItemMeta> {
        Err(CommonError::NotFound.into())
    }

    async fn resolve(&self, params: &ResolveParams) -> MochResult<Resolved> {
        self.cached_link(params).await.or_else(|error| {
            let rules =
                [Rule::new(is_access_denied(&error), StaticResponse::FailedAccess, "Access denied to EasyDebrid {}")];
            static_or_err(&rules, &resolve_target(params), || {
                adding_error("EasyDebrid", quoted(easydebrid_text(&error)))
            })
        })
    }

    fn to_common_error(&self, error: &MochError) -> Option<CommonError> {
        common_error(error)
    }
}

impl EasyDebrid {
    async fn cached_link(&self, params: &ResolveParams) -> MochResult<Resolved> {
        let magnet = encode_magnet(&params.info_hash, None, &[]);
        let generated = self.client.generate_link(&params.api_key, &magnet).await?;
        if generated.files.is_empty() {
            return Err(MochError::message("No cached entry found"));
        }
        let videos = sorted_videos(&generated.files);
        let Some(target) = target_video(&videos, &params.cached_entry_info, params.file_index) else {
            tracing::info!(
                moch = "easydebrid",
                info_hash = %params.info_hash,
                file_index = %index_text(params.file_index),
                "Only EasyDebrid archive is available"
            );
            return Ok(StaticResponse::FailedRar.into());
        };
        Ok(Resolved::Url(target.1.url.clone()))
    }
}

fn file_path(file: &File) -> String {
    format!("{}/{}", file.directory.join("/"), file.filename)
}

fn sorted_videos(files: &[File]) -> Vec<(String, &File)> {
    let mut videos: Vec<(String, &File)> =
        files.iter().map(|file| (file_path(file), file)).filter(|(path, _)| is_video(path)).collect();
    videos.sort_by_key(|video| std::cmp::Reverse(video.1.size));
    videos
}

fn target_video<'a>(
    videos: &'a [(String, &'a File)],
    target_file_name: &str,
    file_index: Option<i64>,
) -> Option<&'a (String, &'a File)> {
    file_index
        .and_then(|_| videos.iter().find(|(path, _)| same_filename(path, target_file_name)))
        .or_else(|| videos.first())
}

fn common_error(error: &MochError) -> Option<CommonError> {
    match error {
        MochError::Common(common) => Some(*common),
        MochError::Provider(error) if debrid::easydebrid::error_message(error) == NOT_LOGGED_IN => {
            Some(CommonError::BadToken)
        }
        _ => None,
    }
}

fn is_access_denied(error: &MochError) -> bool {
    matches!(error, MochError::Provider(error) if debrid::easydebrid::error_message(error).contains(NOT_PREMIUM))
}

fn easydebrid_text(error: &MochError) -> String {
    error_text(error, debrid::easydebrid::error_message)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn provider_error(message: &str) -> MochError {
        debrid::Error::api(Some(400), json!({ "message": message })).into()
    }

    fn file(directory: &[&str], filename: &str, size: i64) -> File {
        File {
            filename: filename.to_owned(),
            directory: directory.iter().map(|part| (*part).to_owned()).collect(),
            size,
            url: format!("https://cdn/{filename}"),
        }
    }

    #[test]
    fn not_logged_in_maps_to_bad_token() {
        assert_eq!(common_error(&provider_error("Not logged in.")), Some(CommonError::BadToken));
    }

    #[test]
    fn other_messages_are_not_common_errors() {
        assert_eq!(common_error(&provider_error("Not logged in")), None);
        assert_eq!(common_error(&MochError::message("Not logged in.")), None);
    }

    #[test]
    fn not_premium_is_access_denied() {
        assert!(is_access_denied(&provider_error("Error: Account not premium. Upgrade")));
        assert!(!is_access_denied(&provider_error("Not logged in.")));
        assert!(!is_access_denied(&MochError::message("Account not premium.")));
    }

    #[test]
    fn path_joins_directory_and_filename() {
        assert_eq!(file_path(&file(&["dir", "sub"], "a.mkv", 1)), "dir/sub/a.mkv");
    }

    #[test]
    fn path_without_directory_keeps_leading_slash() {
        assert_eq!(file_path(&file(&[], "a.mkv", 1)), "/a.mkv");
    }

    #[test]
    fn largest_video_is_default_target() {
        let files = vec![file(&[], "a.mkv", 10), file(&[], "b.srt", 99), file(&["d"], "c.mkv", 20)];
        let videos = sorted_videos(&files);
        assert_eq!(target_video(&videos, "", None).map(|target| target.0.as_str()), Some("d/c.mkv"));
    }

    #[test]
    fn indexed_target_matches_path_suffix() {
        let files = vec![file(&["d"], "a.mkv", 10), file(&["d"], "c.mkv", 20)];
        let videos = sorted_videos(&files);
        assert_eq!(target_video(&videos, "a.mkv", Some(0)).map(|target| target.0.as_str()), Some("d/a.mkv"));
    }

    #[test]
    fn unmatched_indexed_target_falls_back_to_largest() {
        let files = vec![file(&["d"], "a.mkv", 10), file(&["d"], "c.mkv", 20)];
        let videos = sorted_videos(&files);
        assert_eq!(target_video(&videos, "zzz.mkv", Some(0)).map(|target| target.0.as_str()), Some("d/c.mkv"));
    }

    #[test]
    fn archives_only_means_no_target() {
        let files = vec![file(&[], "a.rar", 10)];
        assert!(target_video(&sorted_videos(&files), "", None).is_none());
    }
}
