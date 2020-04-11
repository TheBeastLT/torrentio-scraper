const { parse } = require('parse-torrent-title');
const { Type } = require('./types');
const repository = require('./repository');
const { getImdbId, getKitsuId } = require('./metadata');
const { parseTorrentFiles } = require('./torrentFiles');

async function createTorrentEntry(torrent, overwrite = false) {
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

  const files = await parseTorrentFiles(torrent)
      .then(files => overwrite ? overwriteExistingFiles(torrent, files) : files);
  if (!files || !files.length) {
    console.log(`no video files found for [${torrent.infoHash}] ${torrent.title}`);
    return;
  }

  return repository.createTorrent(torrent)
      .then(() => Promise.all(files.map(file => repository.createFile(file))))
      .then(() => console.log(`Created entry for [${torrent.infoHash}] ${torrent.title}`));
}

async function overwriteExistingFiles(torrent, files) {
  if (files && files.length) {
    const existingFiles = await repository.getFiles({ infoHash: files[0].infoHash })
        .then((existing) => existing
            .reduce((map, next) => {
              const fileIndex = next.fileIndex !== undefined ? next.fileIndex : null;
              map[fileIndex] = (map[fileIndex] || []).concat(next);
              return map;
            }, {}))
        .catch(() => undefined);
    if (existingFiles && Object.keys(existingFiles).length) {
      return files
          .map(file => {
            const mapping = files.length === 1 && Object.keys(existingFiles).length === 1
                ? Object.values(existingFiles)[0]
                : existingFiles[file.fileIndex !== undefined ? file.fileIndex : null];
            if (mapping) {
              const originalFile = mapping.shift();
              return { ...file, id: originalFile.id, size: originalFile.size || file.size };
            }
            return file;
          })
    }
    return files;
  }
  return Promise.reject(`No video files found for: ${torrent.title}`);
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
      .catch(() => undefined)
      .then(stored => {
        if (stored) {
          stored.seeders = torrent.seeders;
          stored.changed('updatedAt', true);
          return stored.save()
        }
      })
      .catch(error => {
        console.warn('Failed updating seeders:', error);
        return undefined;
      });
}

module.exports = { createTorrentEntry, createSkipTorrentEntry, getStoredTorrentEntry, updateTorrentSeeders };
