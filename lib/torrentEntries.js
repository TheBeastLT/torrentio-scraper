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
  if (!torrent.kitsuId && torrent.type === Type.ANIME) {
    torrent.kitsuId = await getKitsuId(titleInfo)
        .catch(() => undefined);
  }

  if (!torrent.imdbId && !torrent.kitsuId && !titleInfo.complete) {
    console.log(`imdbId or kitsuId not found: ${torrent.title}`);
    repository.createFailedImdbTorrent(torrent);
    return;
  }

  const files = await parseTorrentFiles(torrent);
  if (!files || !files.length) {
    console.log(`no video files found: ${torrent.title}`);
    return;
  }

  repository.createTorrent(torrent)
      .then(() => files.forEach(file => repository.createFile(file)))
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

module.exports = { createTorrentEntry, createSkipTorrentEntry, getStoredTorrentEntry };
