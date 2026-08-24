// Multi-signal detection of Polish releases based on the torrent/file name.
// parse-torrent-title already handles explicit tags (PL, POLISH, Lektor PL...),
// but a lot of Polish releases on general trackers are only identifiable by
// weaker signals (release group, MULTi + Polish context, diacritics, tracker
// watermarks). This module combines those signals into a confidence score so
// integrators can pick their own precision/recall trade-off.
// It is intentionally dependency free, so it can be reused outside the addon.

export const Confidence = {
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
};

const MEDIUM_SCORE = 3;
const HIGH_SCORE = 4;

// Polish specific audio/subtitle tags. A bare "Lektor" or "Napisy" is already
// uniquely Polish, while "Dubbing"/"DUB" alone is generic and needs the PL part.
const LEKTOR_REGEX = /\blektor(?:pl)?\b/i;
const DUBBING_REGEX = /\b(?:dubbing[ ._-]*PL|dubbingpl|PL[ ._-]?DUB(?:BING)?|DUB(?:B|BING)?[ ._-]?PL)\b/i;
const NAPISY_REGEX = /\b(?:napisy(?:pl)?|napiproje?kt|PL[ ._-]?SUB(?:BED|S)?|SUB(?:S|BED)?[ ._-]?PL)\b/i;
// Same guard as parse-torrent-title uses, so "www.site.PL" prefixes don't match.
const LANGUAGE_TAG_REGEX = /(?<!w{3}\.\w+\.)\b(?:PL|POL)\b/i;
// skipped when it is the first word, since then it's likely part of the title,
// e.g. "Polish Wedding (1998)".
const POLISH_WORD_REGEX = /\b(?:polish|polski(?:e|ego)?|po[ ._-]polsku|film[ ._-]polski)\b/i;
const MULTI_REGEX = /\bMULTi?\b/i;
// Curated list of release groups publishing Polish/MULTi-with-Polish releases,
// based on regex sets shared by the Polish Stremio community. Generic words,
// international groups and one-letter tokens were dropped on purpose
// (e.g. FLAME, FOX, GUN, KDE, R2D2, DReaM, bare K) to limit false positives.
// Case sensitive on purpose, to not match unrelated words like "kit".
const POLISH_GROUPS = [
  'A4O', 'ABM', 'AFO', 'AL3X', 'ANONiM', 'AS76', 'AZQ', 'Alusia', 'B2RPL', 'B89', 'BEBLU', 'BODZiO',
  'BP007', 'BiDA', 'BiRD', 'CAMBiO', 'CHOPiN', 'CZRG', 'ChrisVPS', 'CiNEMAET', 'CinemaPolish', 'CoLO',
  'DENDA', 'DSiTE', 'DYZIO', 'DZiDEK', 'DeiX', 'EMiS', 'EnTeR1973', 'FARNA', 'FPL', 'Flipu', 'GHW',
  'GLiMMER', 'GR4PE', 'GameToonHD', 'GarRipzone', 'H3Q', 'HDBEE', 'HMDb', 'Izyk', 'JASKIER', 'Japhson',
  'K041', 'K83', 'KIFR', 'KLiO', 'KPFR', 'KSQ', 'Kbuso', 'KiKO', 'KiT', 'KilKr', 'LTN', 'LTS', 'MAXiM',
  'MORS', 'MiNS', 'Mixio', 'N0B0DY', 'N0L4', 'NitroTeam', 'NoNaNo', 'ODiSON', 'OzW', 'PIXELPOLICE',
  'PLHD', 'PSOTNIK', 'PSiG', 'PTRG', 'PTTrG', 'PdlG', 'PiratesZone', 'ProPLTV', 'RAVoD', 'Ralf',
  'RobSil', 'SK13', 'SYRIX', 'SZAFQU', 'Speedboy', 'Spedboy', 'StarLordX', 'TFSH', 'TV4TG', 'TiTaNiUM',
  'ToP2P', 'WEB4TG', 'WiZARDS', 'XuploaD', 'ZLOCiUTKi', 'alE13', 'd666', 'inTGrity', 'wzrtyk', 'xmatr1x'
];
const POLISH_GROUP_REGEX = new RegExp(`(?:^|[ .([\\]-])(?:${POLISH_GROUPS.join('|')})(?:$|[ .)\\][-])`);
// Known Polish uploader handles appearing in release/file names.
const POLISH_UPLOADERS = [
  'agusiq', 'dabrjarek', 'elladajarek', 'fiona9', 'gamer158', 'joanna668', 'kamil445', 'kamil11124',
  'lufen', 'lysol1', 'maksim80', 'marcin0313', 'marjos83', 'nicollubin', 'pcela', 'potroks', 'spajk85',
  'sy5ka', 'taboon1', 'tokar86a', 'wasik', 'wilu75', 'wosiu', 'zyvela'
];
const POLISH_UPLOADER_REGEX = new RegExp(`\\b(?:${POLISH_UPLOADERS.join('|')})\\b`, 'i');
// Polish tracker watermarks frequently embedded in release/file names.
const POLISH_SITE_REGEX = /best-?torrents|ex-?torrenty|devil-?torrents|polskie-?torrenty|electro-?torrent|helltorrents|xtorrenty|cinemamovies|exitorrent|polishtorrent|cool-?torents|shadows-?torrents|torrentmaniak|topfilmyfilmweb|bigbbs|filetracker|ekipa[ ._-]tnt/i;
const POLISH_DOMAIN_REGEX = /\b[a-z0-9-]+\.pl\b/i;
// Letters unique to the Polish alphabet ("ó" is shared with other languages).
const POLISH_DIACRITICS_REGEX = /[ąćęłńśźż]/i;
// Polish words characteristic for Polish uploads.
const POLISH_PHRASE_REGEX = /\bca[łl]y[ ._-]*film\b|\bodc(?:inek|inki)?\b|\bpaczka\b|\bkolekcja\b|\bminiserial\b|\brekonstrukcja\b|\bwersja\b/i;
const SEZON_REGEX = /\bsezon\b/i; // also used by Turkish releases, so a weak signal
const POLISH_PROVIDERS = ['besttorrents'];

const SIGNALS = [
  { name: 'lektor', score: 4, test: name => LEKTOR_REGEX.test(name) },
  { name: 'dubbing-pl', score: 4, test: name => DUBBING_REGEX.test(name) },
  { name: 'napisy-pl', score: 4, test: name => NAPISY_REGEX.test(name) },
  { name: 'language-tag', score: 4, test: name => LANGUAGE_TAG_REGEX.test(name) },
  { name: 'polish-word', score: 4, test: name => isPolishWordMatch(name) },
  { name: 'polish-phrase', score: 3, test: name => POLISH_PHRASE_REGEX.test(name) },
  { name: 'polish-site', score: 3, test: name => POLISH_SITE_REGEX.test(name) },
  { name: 'polish-diacritics', score: 3, test: name => POLISH_DIACRITICS_REGEX.test(name) },
  { name: 'release-group', score: 2, test: name => POLISH_GROUP_REGEX.test(name) },
  { name: 'polish-uploader', score: 2, test: name => POLISH_UPLOADER_REGEX.test(name) },
  { name: 'polish-domain', score: 2, test: name => POLISH_DOMAIN_REGEX.test(name) },
  { name: 'polish-provider', score: 2, test: (name, provider) => isPolishProvider(provider) },
  { name: 'sezon', score: 1, test: name => SEZON_REGEX.test(name) }
];

export function detectPolishRelease(name, options = {}) {
  const input = name || '';
  const signals = SIGNALS
      .filter(signal => signal.test(input, options.provider))
      .map(signal => ({ name: signal.name, score: signal.score }));
  let score = signals.reduce((total, signal) => total + signal.score, 0);
  const multi = MULTI_REGEX.test(input);
  if (multi && score >= 2 && score < HIGH_SCORE) {
    // MULTi alone is not a Polish signal, but it corroborates weaker ones,
    // since Polish groups/trackers tag Polish audio + original audio as MULTi.
    signals.push({ name: 'multi-corroboration', score: 1 });
    score += 1;
  }
  const confidence = toConfidence(score);
  return {
    isPolish: score >= MEDIUM_SCORE,
    confidence: confidence,
    score: score,
    signals: signals.map(signal => signal.name),
    tags: {
      lektor: LEKTOR_REGEX.test(input),
      dubbing: DUBBING_REGEX.test(input),
      napisy: NAPISY_REGEX.test(input),
      multi: multi
    }
  };
}

function isPolishWordMatch(name) {
  const match = name.match(POLISH_WORD_REGEX);
  // a leading "Polish ..." is most likely part of the actual title
  return !!match && match.index > 0;
}

function isPolishProvider(provider) {
  return !!provider && POLISH_PROVIDERS.includes(provider.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function toConfidence(score) {
  if (score >= HIGH_SCORE) {
    return Confidence.HIGH;
  }
  if (score >= MEDIUM_SCORE) {
    return Confidence.MEDIUM;
  }
  if (score >= 1) {
    return Confidence.LOW;
  }
  return Confidence.NONE;
}
