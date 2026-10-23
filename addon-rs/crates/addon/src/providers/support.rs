use std::fmt::Display;

use serde_json::Value;

use super::{
    CachedEntry, CachedStreams, MochError, MochResult, ResolveParams, Resolved, cache_key, helper::stream_filename,
    static_videos::StaticResponse,
};
use crate::domain::stream::{BehaviorHints, Stream};

pub fn is_truthy(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Bool(false)) && value.as_str().is_none_or(|text| !text.is_empty())
}

pub fn index_text(index: Option<impl Display>) -> String {
    index.map_or_else(|| "undefined".to_owned(), |index| index.to_string())
}

pub fn quoted(text: impl Into<String>) -> String {
    Value::String(text.into()).to_string()
}

pub fn resolve_target(params: &ResolveParams) -> String {
    format!("{} [{}]", params.info_hash, index_text(params.file_index))
}

pub fn adding_error(provider: &str, json: impl Display) -> MochError {
    MochError::message(format!("Failed {provider} adding torrent {json}"))
}

pub fn error_text(error: &MochError, provider: impl FnOnce(&debrid::Error) -> String) -> String {
    match error {
        MochError::Provider(error) => provider(error),
        MochError::Message(message) => message.clone(),
        other => other.to_string(),
    }
}

pub fn info_hashes(streams: &[Stream]) -> Vec<String> {
    streams.iter().filter_map(|stream| stream.info_hash.clone()).collect()
}

pub fn padded_info_hashes(streams: &[Stream]) -> Vec<String> {
    streams.iter().map(|stream| stream.info_hash.clone().unwrap_or_default()).collect()
}

#[derive(Default)]
pub struct Availability {
    pub cached: bool,
    pub behavior_hints: Option<BehaviorHints>,
}

impl From<bool> for Availability {
    fn from(cached: bool) -> Self {
        Self { cached, behavior_hints: None }
    }
}

#[derive(Clone, Copy)]
pub enum CachedName {
    Filename,
    Null,
}

pub fn build_cached<'a, A: Into<Availability>>(
    api_key: &str,
    streams: impl IntoIterator<Item = &'a Stream>,
    name: CachedName,
    mut availability: impl FnMut(usize, &Stream, &str) -> A,
) -> CachedStreams {
    streams
        .into_iter()
        .enumerate()
        .map(|(position, stream)| {
            let info_hash = stream.info_hash.as_deref().unwrap_or_default();
            let Availability { cached, behavior_hints } = availability(position, stream, info_hash).into();
            let name = match name {
                CachedName::Filename => stream_filename(stream),
                CachedName::Null => "null".to_owned(),
            };
            let url = format!("{api_key}/{info_hash}/{name}/{}", index_text(stream.file_idx));
            (cache_key(info_hash, stream.file_idx), CachedEntry { url, cached, behavior_hints })
        })
        .collect()
}

pub struct Rule {
    pub hit: bool,
    pub response: StaticResponse,
    pub log: &'static str,
}

impl Rule {
    pub fn new(hit: bool, response: StaticResponse, log: &'static str) -> Self {
        Self { hit, response, log }
    }
}

pub fn static_or_err(rules: &[Rule], target: &str, failed: impl FnOnce() -> MochError) -> MochResult<Resolved> {
    match rules.iter().find(|rule| rule.hit) {
        Some(rule) => {
            let message = rule.log.trim_end_matches(" {}");
            tracing::info!(%target, "{message}");
            Ok(rule.response.into())
        }
        None => Err(failed()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::domain::stream::BehaviorHints;

    fn stream(info_hash: Option<&str>, file_idx: Option<i32>, filename: &str) -> Stream {
        Stream {
            info_hash: info_hash.map(str::to_owned),
            file_idx,
            behavior_hints: Some(BehaviorHints { filename: Some(filename.to_owned()), ..BehaviorHints::default() }),
            ..Stream::default()
        }
    }

    fn params(file_index: Option<i64>) -> ResolveParams {
        ResolveParams {
            moch_key: "k".to_owned(),
            api_key: "key".to_owned(),
            info_hash: "abc".to_owned(),
            file_index,
            cached_entry_info: String::new(),
            ip: None,
            host: String::new(),
            is_browser: false,
        }
    }

    #[test]
    fn truthiness_follows_javascript() {
        assert!(!is_truthy(&Value::Null));
        assert!(!is_truthy(&json!(false)));
        assert!(!is_truthy(&json!("")));
        assert!(is_truthy(&json!(true)));
        assert!(is_truthy(&json!("x")));
        assert!(is_truthy(&json!([])));
    }

    #[test]
    fn missing_index_is_undefined() {
        assert_eq!(index_text(None::<i64>), "undefined");
        assert_eq!(index_text(Some(3)), "3");
    }

    #[test]
    fn target_combines_hash_and_index() {
        assert_eq!(resolve_target(&params(Some(2))), "abc [2]");
        assert_eq!(resolve_target(&params(None)), "abc [undefined]");
    }

    #[test]
    fn quoted_escapes_json() {
        assert_eq!(quoted("it \"broke\""), "\"it \\\"broke\\\"\"");
    }

    #[test]
    fn adding_error_names_the_provider() {
        assert_eq!(adding_error("Foo", quoted("x")).to_string(), "Failed Foo adding torrent \"x\"");
    }

    #[test]
    fn error_text_dispatches_on_variant() {
        let provider: MochError = debrid::Error::api(Some(400), json!({ "m": 1 })).into();
        assert_eq!(error_text(&provider, |_| "custom".to_owned()), "custom");
        assert_eq!(error_text(&MochError::message("plain"), |_| "custom".to_owned()), "plain");
        assert_eq!(error_text(&MochError::TimedOut, |_| "custom".to_owned()), "Timed out");
    }

    #[test]
    fn hash_lists_differ_on_missing_hashes() {
        let streams = [stream(Some("a"), None, "x"), stream(None, None, "y")];
        assert_eq!(info_hashes(&streams), vec!["a".to_owned()]);
        assert_eq!(padded_info_hashes(&streams), vec!["a".to_owned(), String::new()]);
    }

    #[test]
    fn cached_entries_use_the_stream_filename() {
        let streams = [stream(Some("a"), Some(1), "My File.mkv"), stream(Some("b"), None, "z.mkv")];
        let cached =
            build_cached("key", &streams, CachedName::Filename, |position, _, hash| position == 0 && hash == "a");
        let first = &cached["a@1"];
        assert_eq!(first.url, "key/a/My%20File.mkv/1");
        assert!(first.cached);
        let second = &cached["b@undefined"];
        assert_eq!(second.url, "key/b/z.mkv/undefined");
        assert!(!second.cached);
    }

    #[test]
    fn cached_entries_can_use_a_null_name_and_behavior_hints() {
        let streams = [stream(Some("a"), Some(0), "x.mkv")];
        let cached = build_cached("key", &streams, CachedName::Null, |_, _, _| Availability {
            cached: true,
            behavior_hints: Some(BehaviorHints { video_size: Some(5), ..BehaviorHints::default() }),
        });
        let entry = &cached["a@0"];
        assert_eq!(entry.url, "key/a/null/0");
        assert_eq!(entry.behavior_hints.as_ref().and_then(|hints| hints.video_size), Some(5));
    }

    #[test]
    fn cached_entries_accept_filtered_iterators() {
        let streams = [stream(Some("a"), None, "x"), stream(Some("b"), None, "y")];
        let cached = build_cached("key", streams.iter().skip(1), CachedName::Null, |_, _, _| false);
        assert_eq!(cached.len(), 1);
        assert!(cached.contains_key("b@undefined"));
    }

    #[test]
    fn first_matching_rule_wins() {
        let rules = [
            Rule::new(false, StaticResponse::FailedAccess, "no {}"),
            Rule::new(true, StaticResponse::LimitsExceeded, "limits {}"),
            Rule::new(true, StaticResponse::FailedTooBig, "big {}"),
        ];
        let result = static_or_err(&rules, "abc [1]", || MochError::message("failed"));
        assert_eq!(result.ok(), Some(Resolved::Message(StaticResponse::LimitsExceeded)));
    }

    #[test]
    fn no_matching_rule_returns_the_failure() {
        let rules = [Rule::new(false, StaticResponse::FailedAccess, "no {}")];
        let error = static_or_err(&rules, "abc [1]", || MochError::message("failed")).expect_err("rejection");
        assert_eq!(error.to_string(), "failed");
    }
}
