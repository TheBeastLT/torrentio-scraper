const titleParser = require('parse-torrent-title');
const { Type } = require('./types');
const { mapLanguages } = require('./languages');
const { enrichStreamSources, getSources } = require('./magnetHelper');
const { getSubtitles } = require("./subtitles");

const ADDON_NAME = 'Torrentio';
const SIZE_DELTA = 0.02;
const UNKNOWN_SIZE = 300000000;
const CAM_SOURCES = ['CAM', 'TeleSync', 'TeleCine', 'SCR'];

function toStreamInfo(record) {
  const torrentInfo = titleParser.parse(record.torrent.title);
  const fileInfo = titleParser.parse(record.title);
  const sameInfo = !Number.isInteger(record.fileIndex)
      || Math.abs(record.size / record.torrent.size - 1) < SIZE_DELTA
      || record.title.includes(record.torrent.title);
  const quality = getQuality(record, torrentInfo, fileInfo);
  const hdrProfiles = torrentInfo.hdr || fileInfo.hdr || []
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
        joinDetailParts([quality, joinDetailParts(hdrProfiles, '', ' | ')])
      ],
      '',
      '\n'
  );
  const bingeGroupParts = getBingeGroupParts(record, sameInfo, quality, torrentInfo, fileInfo);
  const bingeGroup = joinDetailParts(bingeGroupParts, "torrentio|", "|")
  const behaviorHints = bingeGroup ? { bingeGroup } : undefined;

  return cleanOutputObject({
    name: name,
    title: title,
    infoHash: record.infoHash,
    fileIdx: record.fileIndex,
    behaviorHints: behaviorHints,
    sources: getSources(record.torrent.trackers, record.infoHash),
    subtitles: getSubtitles(record)
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
  const providerLanguages = record.torrent.languages && titleParser.parse(record.torrent.languages + '.srt').languages || [];
  const torrentLanguages = torrentInfo.languages || [];
  const fileLanguages = fileInfo.languages || [];
  const dubbed = torrentInfo.dubbed || fileInfo.dubbed;
  let languages = Array.from(new Set([].concat(torrentLanguages).concat(fileLanguages).concat(providerLanguages)));
  if (record.kitsuId || record.torrent.type === Type.ANIME) {
    // no need to display japanese for anime
    languages = languages.concat(dubbed ? ['dubbed'] : [])
        .filter(lang => lang !== 'japanese');
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

function enrichStaticInfo(stream) {
  return enrichSubtitles(enrichStreamSources({ ...stream }));
}

function enrichSubtitles(stream) {
  if (stream.subtitles?.length) {
    stream.subtitles = stream.subtitles.map(subtitle =>{
      if (subtitle.url) {
        return subtitle;
      }
      return {
        id: `${subtitle.fileIndex}`,
        lang: subtitle.lang,
        url: `http://localhost:11470/${subtitle.infoHash}/${subtitle.fileIndex}/${subtitle.title.split('/').pop()}`
      };
    });
  }
  return stream;
}

function getBingeGroupParts(record, sameInfo, quality, torrentInfo, fileInfo) {
  if (record.torrent.type === Type.MOVIE) {
    const source = torrentInfo.source || fileInfo.source
    return [quality]
        .concat(source !== quality ? source : [])
        .concat(torrentInfo.codec || fileInfo.codec)
        .concat(torrentInfo.bitDepth || fileInfo.bitDepth)
        .concat(torrentInfo.hdr || fileInfo.hdr);
  } else if (sameInfo) {
    return [quality]
        .concat(fileInfo.hdr)
        .concat(fileInfo.group);
  }
  return [record.infoHash];
}

function cleanOutputObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([_, v]) => v != null));
}

module.exports = { toStreamInfo, applyStaticInfo };
