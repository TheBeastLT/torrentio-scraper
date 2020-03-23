const { parse } = require('parse-torrent-title');
const { Type } = require('./types');
const repository = require('./repository');
const { getImdbId, getKitsuId } = require('./metadata');
const { parseTorrentFiles } = require('./torrentFiles');

async function createTorrentEntry(torrent) {
  const titleInfo = parse(torrent.title);

  if (titleInfo.seasons && torrent.type === Type.MOVIE) {
    // sometimes series torrent might be put into movies category
    torrent.type = Type.SERIES;
  }
  if (!torrent.imdbId && torrent.type !== Type.ANIME) {
    torrent.imdbId = await getImdbId(titleInfo, torrent.type)
        .catch(() => undefined);
  }
  if (torrent.imdbId && torrent.imdbId.length < 9) {
    // pad zeros to imdbId if missing
    torrent.imdbId = 'tt' + torrent.imdbId.replace('tt', '').padStart(7, '0');
  }
  if (torrent.imdbId && torrent.imdbId.length > 9 && torrent.imdbId.startsWith('tt0')) {
    // sanitize imdbId from redundant zeros
    torrent.imdbId = torrent.imdbId.replace(/tt0+([0-9]{7,})$/, 'tt$1');
  }
  if (!torrent.kitsuId && torrent.type === Type.ANIME) {
    torrent.kitsuId = await getKitsuId(titleInfo)
        .catch(() => undefined);
  }

  if (!torrent.imdbId && !torrent.kitsuId && !titleInfo.complete && typeof titleInfo.year !== 'string') {
    console.log(`imdbId or kitsuId not found: ${torrent.title}`);
    return;
  }

  const files = await parseTorrentFiles(torrent);
  if (!files || !files.length) {
    console.log(`no video files found: ${torrent.title}`);
    return;
  }

  return repository.createTorrent(torrent)
      .then(() => Promise.all(files.map(file => repository.createFile(file))))
      .then(() => console.log(`Created entry for ${torrent.title}`));
}

async function createSkipTorrentEntry(torrent) {
  return repository.createSkipTorrent(torrent);
}

async function getStoredTorrentEntry(torrent) {
  return repository.getSkipTorrent(torrent)
      .catch(() => repository.getTorrent(torrent))
      .catch(() => undefined);
}

async function updateTorrentSeeders(torrent) {
  if (torrent.seeders === undefined) {
    return;
  }

  return repository.getTorrent(torrent)
      .then(stored => {
        stored.seeders = torrent.seeders;
        return stored.save();
      }).catch(() => undefined);
}

module.exports = { createTorrentEntry, createSkipTorrentEntry, getStoredTorrentEntry, updateTorrentSeeders };
