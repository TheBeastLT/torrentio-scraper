const languageMapping = {
  'dubbed': 'Dubbed',
  'multi audio': 'Multi Audio',
  'multi subs': 'Multi Subs',
  'dual audio': 'Dual Audio',
  'english': '🇬🇧',
  'japanese': '🇯🇵',
  'russian': '🇷🇺',
  'italian': '🇮🇹',
  'portuguese': '🇵🇹',
  'spanish': '🇪🇸',
  'latino': '🇲🇽',
  'korean': '🇰🇷',
  'chinese': '🇨🇳',
  'taiwanese': '🇹🇼',
  'french': '🇫🇷',
  'german': '🇩🇪',
  'dutch': '🇳🇱',
  'hindi': '🇮🇳',
  'telugu': '🇮🇳',
  'tamil': '🇮🇳',
  'polish': '🇵🇱',
  'lithuanian': '🇱🇹',
  'latvian': '🇱🇻',
  'estonian': '🇪🇪',
  'czech': '🇨🇿',
  'slovakian': '🇸🇰',
  'slovenian': '🇸🇮',
  'hungarian': '🇭🇺',
  'romanian': '🇷🇴',
  'bulgarian': '🇧🇬',
  'serbian': '🇷🇸  ',
  'croatian': '🇭🇷',
  'ukrainian': '🇺🇦',
  'greek': '🇬🇷',
  'danish': '🇩🇰',
  'finnish': '🇫🇮',
  'swedish': '🇸🇪',
  'norwegian': '🇳🇴',
  'turkish': '🇹🇷',
  'arabic': '🇸🇦',
  'persian': '🇮🇷',
  'hebrew': '🇮🇱',
  'vietnamese': '🇻🇳',
  'indonesian': '🇮🇩',
  'malay': '🇲🇾',
  'thai': '🇹🇭'
}

export const LanguageOptions = {
  key: 'language',
  options: Object.keys(languageMapping).slice(5).map(lang => ({
    key: lang,
    label: `${languageMapping[lang]} ${lang.charAt(0).toUpperCase()}${lang.slice(1)}`
  }))
}

export const LANGUAGES_PREFIX = '🌐 ';
export const LANGUAGES_DELIMITER = ' · ';

// maps parsed languages to plain display names (no flags), ordered by the language mapping order
export function mapLanguages(languages) {
  const order = Object.keys(languageMapping);
  const mapped = languages
      .filter(language => languageMapping[language])
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const unmapped = languages
      .filter(language => !languageMapping[language])
      .sort((a, b) => a.localeCompare(b))
  return [...new Set([].concat(mapped).concat(unmapped).map(languageLabel))];
}

export function languageLabel(language) {
  return language.replace(/(^|\s)\S/g, letter => letter.toUpperCase());
}

export function containsLanguage(stream, languages) {
  const languagesLine = stream.title.split('\n').find(line => line.startsWith(LANGUAGES_PREFIX));
  if (languagesLine) {
    const labels = languagesLine.slice(LANGUAGES_PREFIX.length).split(LANGUAGES_DELIMITER);
    return languages.some(lang => labels.includes(languageLabel(lang)));
  }
  // streams cached before the plain-text languages line still display flags
  return languages.map(lang => languageMapping[lang]).some(lang => lang && stream.title.includes(lang));
}

export function languageFromCode(code) {
  const entry = Object.entries(languageMapping).find(entry => entry[1] === code);
  return entry?.[0];
}
