const titleParser = require('parse-torrent-title');
const { Type } = require('./types');

const ADDON_NAME = 'Torrentio';

function toStreamInfo(record) {
  if (record.torrent.type === Type.MOVIE) {
    return movieStream(record);
  }
  return seriesStream(record);
}

function movieStream(record) {
  const titleInfo = titleParser.parse(record.title);
  const sameInfo = record.title === record.torrent.title;
  const title = joinDetailParts(
      [
        joinDetailParts([!sameInfo && record.torrent.title.replace(/[, ]+/g, ' ') || undefined]),
        joinDetailParts([titleInfo.title, titleInfo.year, titleInfo.language]),
        joinDetailParts([titleInfo.resolution, titleInfo.source], '📺 '),
        joinDetailParts([record.torrent.seeders], '👤 ')
      ],
      '',
      '\n'
  );

  return {
    name: `${ADDON_NAME}\n${record.torrent.provider}`,
    title: title,
    infoHash: record.infoHash,
  };
}

function seriesStream(record) {
  const tInfo = titleParser.parse(record.title);
  const eInfo = titleParser.parse(record.torrent.title);
  const sameInfo = tInfo.season === eInfo.season && tInfo.episode && eInfo.episode === tInfo.episode;
  const title = joinDetailParts(
      [
        joinDetailParts([record.torrent.title.replace(/[, ]+/g, ' ')]),
        joinDetailParts([!sameInfo && record.title.replace(/[, ]+/g, ' ') || undefined]),
        joinDetailParts([
          tInfo.resolution || eInfo.resolution || record.torrent.resolution,
          tInfo.source || eInfo.source
        ], '📺 '),
        joinDetailParts([record.torrent.seeders], '👤 ')
      ],
      '',
      '\n'
  );

  return {
    name: `${ADDON_NAME}\n${record.torrent.provider}`,
    title: title,
    infoHash: record.infoHash,
    fileIdx: record.fileIndex,
  };
}

function joinDetailParts(parts, prefix = '', delimiter = ' ') {
  const filtered = parts.filter((part) => part !== undefined && part !== null).join(delimiter);

  return filtered.length > 0 ? `${prefix}${filtered}` : undefined;
}

module.exports = { toStreamInfo };
