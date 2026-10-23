use std::{collections::HashSet, sync::Arc};

use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat};
use debrid::torbox::{Client, File, Item, Kind};
use percent_encoding::percent_decode_str;

use super::{
    CachedStreams, CommonError, Context, Moch, MochError, MochResult, ResolveParams, Resolved,
    helper::{same_filename, stream_filename},
    static_videos::StaticResponse,
    support::{
        Availability, CachedName, Rule, build_cached, index_text, info_hashes, quoted, resolve_target, static_or_err,
    },
};
use crate::{
    domain::config::Config,
    domain::extension::{is_archive, is_video},
    domain::models::{CatalogMeta, ItemMeta, Video, VideoStream},
    domain::stream::{BehaviorHints, Stream},
    infrastructure::magnet::magnet_link,
};

const KEY: &str = "torbox";
const ACCESS_DENIED: &[&str] = &["AUTH_ERROR", "BAD_TOKEN", "PLAN_RESTRICTED_FEATURE"];
const LIMIT_EXCEEDED: &[&str] = &["MONTHLY_LIMIT", "COOLDOWN_LIMIT", "ACTIVE_LIMIT", "RATE_LIMIT_EXCEEDED"];
const SEEDING_STATES: &[&str] = &["seeding", "uploading", "uploading (no peers)"];

struct TorBox {
    context: Arc<Context>,
    client: Client,
}

pub fn build(context: Arc<Context>) -> Box<dyn Moch> {
    let client = match context.endpoints.torbox.as_ref().filter(|url| !url.is_empty()) {
        Some(url) => Client::with_base_url(context.http.clone(), url.clone()),
        None => Client::new(context.http.clone()),
    };
    Box::new(TorBox { context, client })
}

#[async_trait]
impl Moch for TorBox {
    async fn cached_streams(
        &self,
        streams: &[Stream],
        api_key: &str,
        _ip: Option<&str>,
    ) -> MochResult<Option<CachedStreams>> {
        let available = match self.client.check_cached(api_key, &info_hashes(streams)).await {
            Ok(results) => debrid::torbox::index_by_hash(results),
            Err(error) => {
                tracing::warn!(moch = "torbox", error = %error, "Failed TorBox cached torrent availability request");
                let error = MochError::from(error);
                return if self.to_common_error(&error).is_some() { Err(error) } else { Ok(None) };
            }
        };
        let cached = build_cached(api_key, streams, CachedName::Filename, |_, stream, info_hash| {
            let entry = available.get(info_hash);
            let target_file_name = percent_decode_str(&stream_filename(stream)).decode_utf8_lossy().into_owned();
            let mut videos: Vec<&File> = entry
                .map(|entry| entry.files.iter().filter(|file| is_video(&file.short_name)).collect())
                .unwrap_or_default();
            videos.sort_by_key(|video| std::cmp::Reverse(video.size));
            let target = stream
                .file_idx
                .and_then(|_| videos.iter().find(|video| same_torbox_filename(&video.name, &target_file_name)))
                .or_else(|| videos.first())
                .copied();
            let behavior_hints = target.and_then(|video| {
                video.opensubtitles_hash.as_ref().filter(|hash| !hash.is_empty()).map(|hash| BehaviorHints {
                    video_size: Some(video.size),
                    video_hash: Some(hash.clone()),
                    ..BehaviorHints::default()
                })
            });
            Availability { cached: entry.is_some(), behavior_hints }
        });
        Ok(Some(cached))
    }

    async fn catalog(&self, api_key: &str, catalog_id: &str, config: &Config) -> MochResult<Vec<CatalogMeta>> {
        let kind = Kind::parse(catalog_id)
            .ok_or_else(|| MochError::message(format!("Unknown TorBox catalog {catalog_id}")))?;
        let items = self.client.list(api_key, kind, config.skip()).await?;
        Ok(items
            .into_iter()
            .filter(status_ready)
            .map(|item| CatalogMeta {
                id: format!("{KEY}:{catalog_id}-{}", item.id),
                kind: "other".to_owned(),
                name: item.name,
            })
            .collect())
    }

    async fn item_meta(&self, item_id: &str, api_key: &str, _ip: Option<&str>) -> MochResult<ItemMeta> {
        let (kind_name, id) = item_id.split_once('-').ok_or(CommonError::NotFound)?;
        let kind = Kind::parse(kind_name).ok_or(CommonError::NotFound)?;
        let id: i64 = id.split('-').next().and_then(|id| id.parse().ok()).ok_or(CommonError::NotFound)?;
        let item = self.client.get(api_key, kind, id).await?.ok_or(CommonError::NotFound)?;
        let created = DateTime::parse_from_rfc3339(&item.created_at).ok();
        let videos = item
            .files
            .iter()
            .filter(|file| is_video(&file.short_name))
            .enumerate()
            .map(|(index, file)| Video {
                id: format!("{KEY}:{item_id}:{}", file.id),
                title: file.name.clone(),
                released: created.map(|created| {
                    (created - chrono::Duration::milliseconds(index as i64))
                        .to_utc()
                        .to_rfc3339_opts(SecondsFormat::Millis, true)
                }),
                streams: vec![VideoStream {
                    url: self.client.download_link(api_key, kind, &id.to_string(), &file.id.to_string()),
                    behavior_hints: None,
                }],
                ..Video::default()
            })
            .collect();
        Ok(ItemMeta {
            id: format!("{KEY}:{item_id}"),
            kind: "other".to_owned(),
            name: item.name,
            info_hash: Some(item.hash).filter(|hash| !hash.is_empty()),
            videos,
            ..ItemMeta::default()
        })
    }

    async fn resolve(&self, params: &ResolveParams) -> MochResult<Resolved> {
        match self.resolve_inner(params).await {
            Ok(url) => Ok(url),
            Err(error) => Self::static_for_error(&error, params),
        }
    }

    fn to_common_error(&self, error: &MochError) -> Option<CommonError> {
        match error {
            MochError::Common(common) => Some(*common),
            MochError::Provider(error) => match error.code() {
                Some("BAD_TOKEN") => Some(CommonError::BadToken),
                Some(code) if ACCESS_DENIED.contains(&code) => Some(CommonError::AccessDenied),
                _ => None,
            },
            _ => None,
        }
    }
}

impl TorBox {
    fn static_for_error(error: &MochError, params: &ResolveParams) -> MochResult<Resolved> {
        let provider = error.provider();
        let code = provider.and_then(|provider| provider.code()).unwrap_or_default();
        let detail_contains = |text: &str| {
            code == "DIFF_ISSUE" && provider.and_then(debrid::Error::detail).is_some_and(|detail| detail.contains(text))
        };
        let rules = [
            Rule::new(ACCESS_DENIED.contains(&code), StaticResponse::FailedAccess, "Access denied to TorBox {}"),
            Rule::new(
                LIMIT_EXCEEDED.contains(&code) || detail_contains("maximum queued"),
                StaticResponse::LimitsExceeded,
                "Limits exceeded to TorBox {}",
            ),
            Rule::new(code == "DOWNLOAD_TOO_LARGE", StaticResponse::FailedTooBig, "Torrent too big for TorBox {}"),
            Rule::new(detail_contains("already queued"), StaticResponse::Downloading, "Downloading to TorBox {}..."),
        ];
        static_or_err(&rules, &resolve_target(params), || {
            MochError::message(format!("Failed TorBox adding torrent: {}", message_json(error)))
        })
    }

    async fn resolve_inner(&self, params: &ResolveParams) -> MochResult<Resolved> {
        let api_key = params.api_key.as_str();
        let info_hash = params.info_hash.as_str();
        if info_hash.contains('-') {
            let mut parts = info_hash.split('-');
            let (kind, root_id, file_id) =
                (parts.next().unwrap_or_default(), parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
            let kind = Kind::parse(kind).ok_or_else(|| MochError::message(format!("Unknown TorBox type {kind}")))?;
            return Ok(Resolved::Url(self.client.download_link(api_key, kind, root_id, file_id)));
        }
        let torrent = self.create_torrent(api_key, info_hash, 1).await?;
        if status_ready(&torrent) {
            return self
                .unrestrict_link(api_key, info_hash, &torrent, &params.cached_entry_info, params.file_index)
                .await;
        }
        if status_downloading(&torrent) {
            tracing::info!(moch = "torbox", %info_hash, file_index = %index_text(params.file_index), "Downloading to TorBox");
            return Ok(StaticResponse::Downloading.into());
        }
        if status_error(&torrent) {
            tracing::warn!(
                moch = "torbox",
                %info_hash,
                torrent = %serde_json::to_string(&torrent).unwrap_or_default(),
                "Retry failed download in TorBox"
            );
            self.client.control_torrent(api_key, torrent.id, "delete").await?;
            return self.retry_create_torrent(params).await;
        }
        Err(MochError::message(format!(
            "Failed TorBox adding torrent {}",
            serde_json::to_string(&torrent).unwrap_or_default()
        )))
    }

    async fn create_torrent(&self, api_key: &str, info_hash: &str, attempts: u32) -> MochResult<Item> {
        let magnet = magnet_link(self.context.repository.as_ref(), info_hash).await;
        let created = self.client.create_torrent(api_key, &magnet, false).await?;
        if let Some(torrent_id) = created.torrent_id {
            return self
                .client
                .get(api_key, Kind::Torrents, torrent_id)
                .await?
                .ok_or_else(|| MochError::message(format!("Unexpected create data: {{\"torrent_id\":{torrent_id}}}")));
        }
        if let Some(queued_id) = created.queued_id {
            return Ok(Item { queued_id: Some(queued_id), download_state: "metaDL".to_owned(), ..Item::default() });
        }
        if created.error.as_deref() == Some("ACTIVE_LIMIT") && attempts > 0 {
            self.free_last_active_torrent(api_key).await?;
            return Box::pin(self.create_torrent(api_key, info_hash, attempts - 1)).await;
        }
        Err(MochError::message(format!("Unexpected create data: {created:?}")))
    }

    async fn retry_create_torrent(&self, params: &ResolveParams) -> MochResult<Resolved> {
        let torrent = self.create_torrent(&params.api_key, &params.info_hash, 1).await?;
        if status_ready(&torrent) {
            self.unrestrict_link(
                &params.api_key,
                &params.info_hash,
                &torrent,
                &params.cached_entry_info,
                params.file_index,
            )
            .await
        } else {
            Ok(StaticResponse::FailedDownload.into())
        }
    }

    async fn free_last_active_torrent(&self, api_key: &str) -> MochResult<()> {
        let torrents = self.client.list(api_key, Kind::Torrents, 0).await?;
        if let Some(seeding) =
            torrents.iter().rev().find(|torrent| SEEDING_STATES.contains(&torrent.download_state.as_str()))
        {
            tracing::info!(moch = "torbox", "Stopping seeded item in TorBox to make space");
            return Ok(self.client.control_torrent(api_key, seeding.id, "stop_seeding").await?);
        }
        if let Some(downloading) = torrents.iter().rev().find(|torrent| status_downloading(torrent)) {
            tracing::info!(moch = "torbox", "Deleting downloading item in TorBox to make space");
            return Ok(self.client.control_torrent(api_key, downloading.id, "delete").await?);
        }
        Err(MochError::message("{\"detail\":\"No torrent to pause found\"}"))
    }

    async fn unrestrict_link(
        &self,
        api_key: &str,
        info_hash: &str,
        torrent: &Item,
        target_file_name: &str,
        file_index: Option<i64>,
    ) -> MochResult<Resolved> {
        let mut videos: Vec<&File> = torrent.files.iter().filter(|file| is_video(&file.short_name)).collect();
        videos.sort_by_key(|video| std::cmp::Reverse(video.size));
        let target = if file_index.is_some() {
            videos.iter().find(|video| same_torbox_filename(&video.name, target_file_name)).copied()
        } else {
            videos.first().copied()
        };
        let Some(target) = target else {
            if torrent.files.iter().all(|file| file.zipped) {
                return Ok(StaticResponse::FailedRar.into());
            }
            if videos.is_empty() {
                tracing::warn!(moch = "torbox", %info_hash, file_index = %index_text(file_index), "No TorBox video files found");
                return Ok(if torrent.files.iter().any(|file| is_archive(&file.short_name)) {
                    StaticResponse::FailedRar
                } else {
                    StaticResponse::FailedOpening
                }
                .into());
            }
            if videos.len() == 1 && self.is_single_video_torrent(info_hash).await {
                return Ok(Resolved::Url(self.client.download_link(
                    api_key,
                    Kind::Torrents,
                    &torrent.id.to_string(),
                    &videos[0].id.to_string(),
                )));
            }
            return Err(MochError::message(format!(
                "No TorBox file found for index {} in: {}",
                index_text(file_index),
                serde_json::to_string(torrent).unwrap_or_default()
            )));
        };
        Ok(Resolved::Url(self.client.download_link(
            api_key,
            Kind::Torrents,
            &torrent.id.to_string(),
            &target.id.to_string(),
        )))
    }

    async fn is_single_video_torrent(&self, info_hash: &str) -> bool {
        let files = self.context.repository.files(&[info_hash.to_owned()]).await.unwrap_or_default();
        files.iter().map(|file| file.title.as_str()).collect::<HashSet<_>>().len() == 1
    }
}

fn message_json(error: &MochError) -> String {
    match error.provider().and_then(debrid::Error::body) {
        Some(body) => body.to_string(),
        None => quoted(error.to_string()),
    }
}

fn same_torbox_filename(filename: &str, expected: &str) -> bool {
    same_filename(filename, expected) || same_filename(&normalize_filename(filename), &normalize_filename(expected))
}

fn normalize_filename(filename: &str) -> String {
    filename.replace('&', "and").chars().filter(|character| character.is_alphanumeric()).collect()
}

fn status_ready(item: &Item) -> bool {
    item.download_present
}

fn status_error(item: &Item) -> bool {
    (!item.active && !item.download_finished) || item.download_state == "error"
}

fn status_downloading(item: &Item) -> bool {
    (!status_ready(item) && !status_error(item)) || item.queued_id.is_some_and(|id| id != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(active: bool, finished: bool, present: bool, state: &str) -> Item {
        Item {
            active,
            download_finished: finished,
            download_present: present,
            download_state: state.to_owned(),
            ..Item::default()
        }
    }

    #[test]
    fn ready_items_are_not_downloading() {
        assert!(!status_downloading(&item(true, true, true, "cached")));
    }

    #[test]
    fn active_unfinished_items_are_downloading() {
        assert!(status_downloading(&item(true, false, false, "downloading")));
    }

    #[test]
    fn inactive_unfinished_items_are_errors() {
        assert!(status_error(&item(false, false, false, "stalled")));
        assert!(status_error(&item(true, true, false, "error")));
    }

    #[test]
    fn queued_items_count_as_downloading() {
        let queued = Item { queued_id: Some(7), download_state: "metaDL".to_owned(), ..Item::default() };
        assert!(status_downloading(&queued));
    }

    #[test]
    fn normalized_names_ignore_punctuation() {
        assert!(same_torbox_filename("Show & Tell (2020).mkv", "Show and Tell 2020 mkv"));
    }
}
