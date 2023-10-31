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

export function mapLanguages(languages) {
  const mapped = languages
      .map(language => languageMapping[language])
      .filter(language => language)
      .sort((a, b) => Object.values(languageMapping).indexOf(a) - Object.values(languageMapping).indexOf(b));
  const unmapped = languages
      .filter(language => !languageMapping[language])
      .sort((a, b) => a.localeCompare(b))
  return [...new Set([].concat(mapped).concat(unmapped))];
}

export function containsLanguage(stream, languages) {
  return languages.map(lang => languageMapping[lang]).some(lang => stream.title.includes(lang));
}

export function languageFromCode(code) {
  const entry = Object.entries(languageMapping).find(entry => entry[1] === code);
  return entry?.[0];
}
