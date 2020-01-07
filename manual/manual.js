require('dotenv').config();
const repository = require('../lib/repository');
const { parseTorrentFiles } = require('../lib/torrentFiles');
const { Type } = require('../lib/types');

async function addMissingEpisodes() {
  const torrent = { infoHash: '0ec780c2c7f8d5b38e61827f0b53c77c3d22f955' };
  const torrentFiles = await require('../lib/torrent').torrentFiles(torrent);
  const storedFiles = await repository.getFiles(torrent)
      .then((files) => files.reduce((map, next) => (map[next.fileIndex] = next, map), {}));
  const imdbId = Object.values(storedFiles)[0].imdbId;

  torrentFiles
      .filter((file) => !storedFiles[file.fileIndex])
      .map((file) => ({
        infoHash: torrent.infoHash,
        fileIndex: file.fileIndex,
        title: file.name,
        size: file.size,
        imdbId: imdbId,
        imdbSeason: parseInt(file.name.match(/(\d+)[ .]?-[ .]?\d+/)[1], 10),
        imdbEpisode: parseInt(file.name.match(/\d+[ .]?-[ .]?(\d+)/)[1], 10),
      }))
      .forEach((file) => repository.createFile(file));
}

async function findAllFiles() {
  const torrent = {
    infoHash: '6b95e5cfde9aaa71970a14f6bb6b9de19e2cbfa1',
    title: '[OMDA] Bleach + Filmes + Ovas (480p-720p x264 AAC-MP3) [rich_jc]',
    type: Type.SERIES
  };
  const imdbId = 'tt0434665';

  return parseTorrentFiles(torrent, imdbId).then((files) => console.log(files));
}

//addMissingEpisodes().then(() => console.log('Finished'));
findAllFiles().then(() => console.log('Finished'));