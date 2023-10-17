const { parse } = require('parse-torrent-title');
const { isExtension } = require("./extension");
const { Providers } = require("./filter");
const { languageFromCode } = require("./languages");

const languageMapping = {
  'english': 'eng',
  'japanese': 'jpn',
  'russian': 'rus',
  'italian': 'ita',
  'portuguese': 'por',
  'spanish': 'spa',
  'latino': 'lat',
  'korean': 'kor',
  'chinese': 'zho',
  'taiwanese': 'zht',
  'french': 'fre',
  'german': 'ger',
  'dutch': 'dut',
  'hindi': 'hin ',
  'telugu': 'tel',
  'tamil': 'tam',
  'polish': 'pol',
  'lithuanian': 'lit',
  'latvian': 'lav',
  'estonian': 'est',
  'czech': 'cze',
  'slovakian': 'slo',
  'slovenian': 'slv',
  'hungarian': 'hun',
  'romanian': 'rum',
  'bulgarian': 'bul',
  'serbian': 'scc',
  'croatian': 'hrv',
  'ukrainian': 'ukr',
  'greek': 'ell',
  'danish': 'dan',
  'finnish': 'fin',
  'swedish': 'swe',
  'norwegian': 'nor',
  'turkish': 'tur',
  'arabic': 'ara',
  'persian': 'per',
  'hebrew': 'heb',
  'vietnamese': 'vie',
  'indonesian': 'ind',
  'thai': 'tha'
}

const ignoreSet = new Set(['dubbed', 'multi audio', 'multi subs', 'dual audio']);
const allowedExtensions = ['srt', 'vtt', 'ass', 'ssa'];

function getSubtitles(record) {
  if (!record.subtitles || !record.subtitles.length) {
    return null;
  }
  return record.subtitles
      .filter(subtitle => isExtension(subtitle.title, allowedExtensions))
      .sort((a, b) => b.size - a.size)
      .map(subtitle => ({
        infoHash: subtitle.infoHash,
        fileIndex: subtitle.fileIndex,
        title: subtitle.title,
        lang: parseLanguage(subtitle.title, record),
      }));
}

function parseLanguage(title, record) {
  const subtitlePathParts = title.split('/');
  const subtitleFileName = subtitlePathParts.pop();
  const subtitleTitleNoExt = title.replace(/\.\w{2,5}$/, '');
  const videoFileName = record.title.split('/').pop().replace(/\.\w{2,5}$/, '');
  const fileNameLanguage = getSingleLanguage(subtitleFileName.replace(videoFileName, ''));
  if (fileNameLanguage) {
    return fileNameLanguage;
  }
  const videoTitleNoExt = record.title.replace(/\.\w{2,5}$/, '');
  if (subtitleTitleNoExt === record.title || subtitleTitleNoExt === videoTitleNoExt) {
    const provider = Providers.options.find(provider => provider.label === record.torrent.provider);
    return provider?.foreign && languageFromCode(provider.foreign) || 'eng';
  }
  const folderName = subtitlePathParts.join('/');
  const folderNameLanguage = getSingleLanguage(folderName.replace(videoFileName, ''));
  if (folderNameLanguage) {
    return folderNameLanguage
  }
  return getFileNameLanguageCode(subtitleFileName) || 'Unknown';
}

function getSingleLanguage(title) {
  const parsedInfo = parse(title);
  const languages = (parsedInfo.languages || []).filter(language => !ignoreSet.has(language));
  return languages.length === 1 ? languageMapping[languages[0]] : undefined;
}

function getFileNameLanguageCode(fileName) {
  const match = fileName.match(/(?:(?:^|[._ ])([A-Za-z][a-z]{1,2})|\[([a-z]{2,3})])\.\w{3,4}$/);
  return match && match[1].toLowerCase();
}

module.exports = { getSubtitles }