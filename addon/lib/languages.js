const languageMapping = {
  'dubbed': 'Dubbed',
  'multi audio': 'Multi Audio',
  'multi subs': 'Multi Subs',
  'dual audio': 'Dual Audio',
  'english': '🇬🇧',
  'japanese': '🇯🇵',
  'korean': '🇰🇷',
  'chinese': '🇨🇳',
  'french': '🇫🇷',
  'german': '🇩🇪',
  'dutch': '🇳🇱',
  'portuguese': '🇵🇹',
  'spanish': '🇪🇸',
  'italian': '🇮🇹',
  'russian': '🇷🇺',
  'hindi': '🇮🇳',
  'telugu': '🇮🇳',
  'tamil': '🇮🇳',
  'polish': '🇵🇱',
  'lithuanian': '🇱🇹',
  'czech': '🇨🇿',
  'hungarian': '🇭🇺',
  'romanian': '🇷🇴',
  'croatian': '🇭🇷',
  'greek': '🇬🇷',
  'danish': '🇩🇰',
  'finnish': '🇫🇮',
  'swedish': '🇸🇪',
  'norwegian': '🇳🇴',
  'turkish': '🇹🇷',
  'arabic': '🇸🇦',
  'hebrew': '🇮🇱'
}

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

module.exports = { mapLanguages }