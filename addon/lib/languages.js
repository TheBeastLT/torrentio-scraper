const languageMapping = {
  'dubbed': 'Dubbed',
  'multi audio': 'Multi Audio',
  'multi subs': 'Multi Subs',
  'dual audio': 'Dual Audio',
  'english': '🇬🇧',
  'japanese': '🇯🇵',
  'russian': '🇷🇺',
  'portuguese': '🇵🇹',
  'spanish': '🇪🇸',
  'italian': '🇮🇹',
  'korean': '🇰🇷',
  'chinese': '🇨🇳',
  'french': '🇫🇷',
  'german': '🇩🇪',
  'dutch': '🇳🇱',
  'hindi': '🇮🇳',
  'telugu': '🇮🇳',
  'tamil': '🇮🇳',
  'polish': '🇵🇱',
  'lithuanian': '🇱🇹',
  'czech': '🇨🇿',
  'slovakian': '🇸🇰',
  'hungarian': '🇭🇺',
  'romanian': '🇷🇴',
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
  'thai': '🇹🇭'
}
const languages = Object.keys(languageMapping).slice(4);

function mapLanguages(languages) {
  const mapped = languages
      .map(language => languageMapping[language])
      .filter(language => language)
      .sort((a, b) => Object.values(languageMapping).indexOf(a) - Object.values(languageMapping).indexOf(b));
  const unmapped = languages
      .filter(language => !languageMapping[language])
      .sort((a, b) => a.localeCompare(b))
  return [...new Set([].concat(mapped).concat(unmapped))];
}

function containsLanguage(stream, languages) {
  return languages.map(lang => languageMapping[lang]).some(lang => stream.title.includes(lang));
}

module.exports = { mapLanguages, containsLanguage, languages }