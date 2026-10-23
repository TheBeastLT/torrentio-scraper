const MAPPING: &[(&str, &str)] = &[
    ("dubbed", "Dubbed"),
    ("multi audio", "Multi Audio"),
    ("multi subs", "Multi Subs"),
    ("dual audio", "Dual Audio"),
    ("english", "🇬🇧"),
    ("japanese", "🇯🇵"),
    ("russian", "🇷🇺"),
    ("italian", "🇮🇹"),
    ("portuguese", "🇵🇹"),
    ("spanish", "🇪🇸"),
    ("latino", "🇲🇽"),
    ("korean", "🇰🇷"),
    ("chinese", "🇨🇳"),
    ("taiwanese", "🇹🇼"),
    ("french", "🇫🇷"),
    ("german", "🇩🇪"),
    ("dutch", "🇳🇱"),
    ("hindi", "🇮🇳"),
    ("telugu", "🇮🇳"),
    ("tamil", "🇮🇳"),
    ("polish", "🇵🇱"),
    ("lithuanian", "🇱🇹"),
    ("latvian", "🇱🇻"),
    ("estonian", "🇪🇪"),
    ("czech", "🇨🇿"),
    ("slovakian", "🇸🇰"),
    ("slovenian", "🇸🇮"),
    ("hungarian", "🇭🇺"),
    ("romanian", "🇷🇴"),
    ("bulgarian", "🇧🇬"),
    ("serbian", "🇷🇸  "),
    ("croatian", "🇭🇷"),
    ("ukrainian", "🇺🇦"),
    ("greek", "🇬🇷"),
    ("danish", "🇩🇰"),
    ("finnish", "🇫🇮"),
    ("swedish", "🇸🇪"),
    ("norwegian", "🇳🇴"),
    ("turkish", "🇹🇷"),
    ("arabic", "🇸🇦"),
    ("persian", "🇮🇷"),
    ("hebrew", "🇮🇱"),
    ("vietnamese", "🇻🇳"),
    ("indonesian", "🇮🇩"),
    ("malay", "🇲🇾"),
    ("thai", "🇹🇭"),
];

const SELECTABLE_FROM: usize = 5;

pub const CONFIG_KEY: &str = "language";

pub struct LanguageOption {
    pub key: &'static str,
    pub label: String,
}

pub fn options() -> Vec<LanguageOption> {
    MAPPING[SELECTABLE_FROM..]
        .iter()
        .map(|(language, flag)| {
            let mut characters = language.chars();
            let capitalized: String =
                characters.next().map(|first| first.to_ascii_uppercase()).into_iter().chain(characters).collect();
            LanguageOption { key: language, label: format!("{flag} {capitalized}") }
        })
        .collect()
}

fn flag(language: &str) -> Option<&'static str> {
    MAPPING.iter().find(|(name, _)| *name == language).map(|(_, flag)| *flag)
}

fn flag_position(flag: &str) -> usize {
    MAPPING.iter().position(|(_, candidate)| *candidate == flag).unwrap_or(usize::MAX)
}

pub fn map_languages<S: AsRef<str>>(languages: &[S]) -> Vec<String> {
    let mut mapped: Vec<&'static str> = languages.iter().filter_map(|language| flag(language.as_ref())).collect();
    mapped.sort_by_key(|flag| flag_position(flag));
    let mut unmapped: Vec<&str> =
        languages.iter().map(AsRef::as_ref).filter(|language| flag(language).is_none()).collect();
    unmapped.sort_unstable();
    let mut result: Vec<String> = Vec::new();
    for entry in mapped.into_iter().chain(unmapped) {
        if !result.iter().any(|existing| existing == entry) {
            result.push(entry.to_owned());
        }
    }
    result
}

pub fn contains_language(title: &str, languages: &[String]) -> bool {
    languages.iter().filter_map(|language| flag(language)).any(|flag| title.contains(flag))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_and_orders_languages() {
        assert_eq!(map_languages(&["french", "english", "dubbed"]), vec!["Dubbed", "🇬🇧", "🇫🇷"]);
    }

    #[test]
    fn keeps_unmapped_languages_sorted_last() {
        assert_eq!(map_languages(&["zulu", "english", "afrikaans"]), vec!["🇬🇧", "afrikaans", "zulu"]);
    }

    #[test]
    fn selectable_options_skip_the_pseudo_languages() {
        assert_eq!(options()[0].key, "japanese");
        assert_eq!(options()[0].label, "🇯🇵 Japanese");
    }

    #[test]
    fn detects_language_flags_in_title() {
        assert!(contains_language("x 🇫🇷 y", &["french".to_owned()]));
        assert!(!contains_language("x 🇫🇷 y", &["german".to_owned()]));
    }
}
