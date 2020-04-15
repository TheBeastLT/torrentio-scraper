const titleParser = require('parse-torrent-title');
const { Type } = require('./types');
const { mapLanguages } = require('./languages');

const ADDON_NAME = 'Torrentio';
const UNKNOWN_SIZE = 300000000;

function toStreamInfo(record) {
  const torrentInfo = titleParser.parse(record.torrent.title);
  const fileInfo = titleParser.parse(record.title);
  const sameInfo = !Number.isInteger(record.fileIndex)
      || record.size !== UNKNOWN_SIZE && record.size === record.torrent.size;
  const title = joinDetailParts(
      [
        joinDetailParts([record.torrent.title.replace(/[, ]+/g, ' ')]),
        joinDetailParts([!sameInfo && record.title.replace(/[, ]+/g, ' ') || undefined]),
        joinDetailParts([
          joinDetailParts([record.torrent.seeders], '👤 '),
          joinDetailParts([formatSize(record.size)], '💾 '),
          joinDetailParts([record.torrent.provider], '🛈 ')
        ]),
        joinDetailParts(getLanguages(record, torrentInfo, fileInfo), '', ' / '),
      ],
      '',
      '\n'
  );
  const name = joinDetailParts(
      [
        joinDetailParts([ADDON_NAME]),
        joinDetailParts([getQuality(record, torrentInfo, fileInfo)])
      ],
      '',
      '\n'
  );

  return {
    name: name,
    title: title,
    infoHash: record.infoHash,
    fileIdx: record.fileIndex
  };
}

function getQuality(record, torrentInfo, fileInfo) {
  const resolution = fileInfo.resolution || torrentInfo.resolution || record.torrent.resolution;
  const source = fileInfo.source || torrentInfo.source;
  if (['CAM', 'TeleSync'].includes(source)) {
    return source;
  }
  return resolution || source;
}

function getLanguages(record, torrentInfo, fileInfo) {
  const providerLanguages = record.torrent.languages && titleParser.parse(record.torrent.languages).languages || [];
  const torrentLanguages = torrentInfo.languages || [];
  let languages = [].concat(torrentLanguages).concat(providerLanguages);
  if (record.kitsuId || record.torrent.type === Type.ANIME) {
    const dubbed = torrentInfo.dubbed || fileInfo.dubbed || languages.includes('multi');
    // no need to display japanese for anime or english if anime is dubbed
    languages = languages.concat(dubbed ? ['dubbed'] : [])
        .filter(lang => lang !== 'japanese')
        .filter(lang => dubbed && lang !== 'english' || !dubbed);
  }
  if (languages.length === 1 && languages.includes('english')) {
    // no need to display languages if only english is present
    languages = [];
  }
  return mapLanguages(languages);
}

function joinDetailParts(parts, prefix = '', delimiter = ' ') {
  const filtered = parts.filter((part) => part !== undefined && part !== null).join(delimiter);

  return filtered.length > 0 ? `${prefix}${filtered}` : undefined;
}

function formatSize(size) {
  if (size === UNKNOWN_SIZE) {
    return undefined;
  }
  const i = size === 0 ? 0 : Math.floor(Math.log(size) / Math.log(1024));
  return Number((size / Math.pow(1024, i)).toFixed(2)) + ' ' + ['B', 'kB', 'MB', 'GB', 'TB'][i];
}

module.exports = { toStreamInfo };
