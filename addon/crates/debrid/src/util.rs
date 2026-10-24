use serde::{Deserialize, Deserializer, de::DeserializeOwned};
use serde_json::Value;

use crate::{Error, Result};

pub fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::Array(_) | Value::Object(_) => true,
    }
}

pub fn parse_value<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|error| Error::Other(error.to_string()))
}

pub fn parse_or_default<T: DeserializeOwned + Default>(value: Value) -> Result<T> {
    if value.is_null() {
        return Ok(T::default());
    }
    parse_value(value)
}

pub fn null_default<'de, D, T>(deserializer: D) -> std::result::Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[derive(Debug, Default, Deserialize, PartialEq)]
    struct Item {
        #[serde(default, deserialize_with = "null_default")]
        names: Vec<String>,
    }

    #[test]
    fn truthiness_follows_javascript() {
        assert!(!is_truthy(&json!(null)));
        assert!(!is_truthy(&json!(false)));
        assert!(!is_truthy(&json!("")));
        assert!(!is_truthy(&json!(0)));
        assert!(is_truthy(&json!(true)));
        assert!(is_truthy(&json!("x")));
        assert!(is_truthy(&json!(2)));
        assert!(is_truthy(&json!([])));
        assert!(is_truthy(&json!({})));
    }

    #[test]
    fn parse_value_reports_shape_errors() {
        assert!(parse_value::<Item>(json!([1])).is_err());
        assert_eq!(parse_value::<Item>(json!({ "names": ["a"] })).expect("item").names, vec!["a"]);
    }

    #[test]
    fn parse_or_default_maps_null_to_default() {
        assert_eq!(parse_or_default::<Item>(Value::Null).expect("item"), Item::default());
        assert!(parse_or_default::<Item>(json!("x")).is_err());
    }

    #[test]
    fn null_default_replaces_null() {
        assert_eq!(parse_value::<Item>(json!({ "names": null })).expect("item"), Item::default());
    }
}
