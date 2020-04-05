const titleParser = require('parse-torrent-title');

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
        joinDetailParts([formatSize(record.size), record.torrent.provider], '⚙️️ '),
        joinDetailParts([record.torrent.seeders], '👤 ')
      ],
      '',
      '\n'
  );
  const name = joinDetailParts(
      [
        joinDetailParts([ADDON_NAME]),
        joinDetailParts([
          fileInfo.resolution ||
          torrentInfo.resolution ||
          record.torrent.resolution ||
          fileInfo.source ||
          torrentInfo.source
        ])
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
