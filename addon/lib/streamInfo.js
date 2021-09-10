const titleParser = require('parse-torrent-title');
const { Type } = require('./types');
const { mapLanguages } = require('./languages');
const { getAllTrackers } = require('./magnetHelper');

const ADDON_NAME = 'Torrentio';
const SIZE_DELTA = 0.02;
const UNKNOWN_SIZE = 300000000;
const CAM_SOURCES = ['CAM', 'TeleSync', 'TeleCine'];
const ANIME_PROVIDERS = [
  'HorribleSubs',
  'NyaaSi',
  'NyaaPantsu'
].map(provider => provider.toLowerCase());

function toStreamInfo(record) {
  const torrentInfo = titleParser.parse(record.torrent.title);
  const fileInfo = titleParser.parse(record.title);
  const sameInfo = !Number.isInteger(record.fileIndex)
      || Math.abs(record.size / record.torrent.size - 1) < SIZE_DELTA
      || record.title.includes(record.torrent.title);
  const quality = getQuality(record, torrentInfo, fileInfo);
  const title = joinDetailParts(
      [
        joinDetailParts([record.torrent.title.replace(/[, ]+/g, ' ')]),
        joinDetailParts([!sameInfo && record.title || undefined]),
        joinDetailParts([
          joinDetailParts([record.torrent.seeders], '👤 '),
          joinDetailParts([formatSize(record.size)], '💾 '),
          joinDetailParts([record.torrent.provider], '⚙️ ')
        ]),
        joinDetailParts(getLanguages(record, torrentInfo, fileInfo), '', ' / '),
      ],
      '',
      '\n'
  );
  const name = joinDetailParts(
      [
        joinDetailParts([ADDON_NAME]),
        joinDetailParts([quality])
      ],
      '',
      '\n'
  );
  const behaviorHints = {
    bingeGroup: sameInfo
        ? `torrentio|${quality}|${fileInfo.group}`
        : `torrentio|${record.infoHash}`
  };

  return cleanOutputObject({
    name: name,
    title: title,
    infoHash: record.infoHash,
    fileIdx: record.fileIndex,
    behaviorHints: record.torrent.type !== Type.MOVIE ? behaviorHints : null,
    sources: getSources(record.torrent.trackers, record.infoHash)
  });
}

function getQuality(record, torrentInfo, fileInfo) {
  if (CAM_SOURCES.includes(fileInfo.source)) {
    return fileInfo.source;
  }
  if (CAM_SOURCES.includes(torrentInfo.source)) {
    return torrentInfo.source;
  }
  const resolution = fileInfo.resolution || torrentInfo.resolution || record.torrent.resolution;
  const source = fileInfo.source || torrentInfo.source;
  return resolution || source;
}

function getLanguages(record, torrentInfo, fileInfo) {
  const providerLanguages = record.torrent.languages && titleParser.parse(record.torrent.languages).languages || [];
  const torrentLanguages = torrentInfo.languages || [];
  const fileLanguages = fileInfo.languages || [];
  const dubbed = torrentInfo.dubbed || fileInfo.dubbed;
  let languages = Array.from(new Set([].concat(torrentLanguages).concat(fileLanguages).concat(providerLanguages)));
  if (record.kitsuId || record.torrent.type === Type.ANIME) {
    // no need to display japanese for anime or english if anime is dubbed
    languages = languages.concat(dubbed ? ['dubbed'] : [])
        .filter(lang => lang !== 'japanese')
        .filter(lang => dubbed && lang !== 'english' || !dubbed);
  }
  if (languages.length === 1 && languages.includes('english')) {
    // no need to display languages if only english is present
    languages = [];
  }
  if (languages.length === 0 && dubbed) {
    // display dubbed only if there are no other languages defined for non anime
    languages = ['dubbed'];
  }
  return mapLanguages(languages);
}

function joinDetailParts(parts, prefix = '', delimiter = ' ') {
  const filtered = parts.filter((part) => part !== undefined && part !== null).join(delimiter);

  return filtered.length > 0 ? `${prefix}${filtered}` : undefined;
}

function formatSize(size) {
  if (!size) {
    return undefined;
  }
  if (size === UNKNOWN_SIZE) {
    return undefined;
  }
  const i = size === 0 ? 0 : Math.floor(Math.log(size) / Math.log(1024));
  return Number((size / Math.pow(1024, i)).toFixed(2)) + ' ' + ['B', 'kB', 'MB', 'GB', 'TB'][i];
}

function applyStaticInfo(streams) {
  return streams.map(stream => enrichStaticInfo(stream));
}

function enrichStreamSources(stream) {
  const match = stream.title.match(/⚙.* ([^ \n]+)/);
  const provider = match && match[1].toLowerCase();
  if (ANIME_PROVIDERS.includes(provider)) {
    const sources = getSources(getAllTrackers(), stream.infoHash);
    return { ...stream, sources };
  }
  return stream;
}

function enrichStaticInfo(stream) {
  return enrichStreamSources(stream);
}

function getSources(trackersInput, infoHash) {
  if (!trackersInput) {
    return null;
  }
  const trackers = Array.isArray(trackersInput) ? trackersInput : trackersInput.split(',');
  return trackers.map(tracker => `tracker:${tracker}`).concat(`dht:${infoHash}`)
}

function cleanOutputObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([_, v]) => v != null));
}

module.exports = { toStreamInfo, applyStaticInfo };
