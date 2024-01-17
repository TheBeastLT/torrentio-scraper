const Bottleneck = require('bottleneck');
const { parse } = require('parse-torrent-title');
const Promises = require('../lib/promises');
const { mostCommonValue } = require('../lib/promises');
const repository = require('../lib/repository');
const { getImdbId, getKitsuId } = require('../lib/metadata');
const { parseTorrentFiles } = require('../lib/torrentFiles');
const { createTorrentContents } = require('../lib/torrentEntries');
const { assignSubtitles } = require('../lib/torrentSubtitles');
const { Type } = require('../lib/types');

const limiter = new Bottleneck({ maxConcurrent: 40 });

async function updateMovieCollections() {
  const collectionFiles = await repository.getFilesBasedOnTitle('logy')
      .then(files => files.filter(file => file.fileIndex === null))
      .then(files => files.filter(file => parse(file.title).complete));

  collectionFiles.map(original => repository.getTorrent({ infoHash: original.infoHash })
      .then(torrent => parseTorrentFiles({ ...torrent.get(), imdbId: original.imdbId }))
      .then(files => Promise.all(files.map(file => {
        console.log(file);
        return repository.createFile(file)
      })))
      .then(createdFiled => {
        if (createdFiled && createdFiled.length) {
          console.log(`Updated movie collection ${original.title}`);
          repository.deleteFile(original)
        } else {
          console.log(`Failed updating movie collection ${original.title}`);
        }
      }));
}

async function reapplySeriesSeasonsSavedAsMovies() {
  return repository.getTorrentsBasedOnTitle('(?:[^a-zA-Z0-9]|^)[Ss][012]?[0-9](?:[^0-9]|$)', Type.MOVIE)
      .then(torrents => Promise.all(torrents
          .filter(torrent => parse(torrent.title).seasons)
          .map(torrent => limiter.schedule(() => reapplyEpisodeDecomposing(torrent.infoHash, false)
              .then(() => {
                torrent.type = Type.SERIES;
                return torrent.save();
              })))))
      .then(() => console.log('Finished updating multiple torrents'));
}

async function reapplyDecomposingToTorrentsOnRegex(regex) {
  return repository.getTorrentsBasedOnTitle(regex, Type.ANIME)
      .then(torrents => Promise.all(torrents
          .map(torrent => limiter.schedule(() => reapplyEpisodeDecomposing(torrent.infoHash, true)))))
      .then(() => console.log('Finished updating multiple torrents'));
}

async function reapplyEpisodeDecomposing(infoHash, includeSourceFiles = true) {
  const torrent = await repository.getTorrent({ infoHash });
  const storedFiles = await repository.getFiles({ infoHash });
  const fileIndexMap = storedFiles
      .reduce((map, next) => {
        const fileIndex = next.fileIndex !== undefined ? next.fileIndex : null;
        map[fileIndex] = (map[fileIndex] || []).concat(next);
        return map;
      }, {});
  const files = includeSourceFiles && Object.values(fileIndexMap)
      .map(sameIndexFiles => sameIndexFiles[0])
      .map(file => ({
        fileIndex: file.fileIndex,
        name: file.title.replace(/.*\//, ''),
        path: file.title,
        size: file.size
      }));
  const kitsuId = undefined;
  const imdbId = kitsuId
      ? undefined
      : mostCommonValue(storedFiles.map(file => file.imdbId))
      || await getImdbId(parse(torrent.title)).catch(() => undefined);

  if (!imdbId && !kitsuId) {
    console.log(`imdbId or kitsuId not found:  ${torrent.provider} ${torrent.title}`);
    return Promise.resolve();
  }

  return parseTorrentFiles({ ...torrent.get(), imdbId, kitsuId, files })
      .then(torrentContents => torrentContents.videos)
      .then(newFiles => newFiles.map(file => {
        const fileIndex = file.fileIndex !== undefined ? file.fileIndex : null;
        const mapping = fileIndexMap[fileIndex];
        if (mapping) {
          const originalFile = mapping.shift();
          if (originalFile) {
            if (!originalFile.imdbId) {
              originalFile.imdbId = file.imdbId
            }
            originalFile.imdbSeason = file.imdbSeason;
            originalFile.imdbEpisode = file.imdbEpisode;
            originalFile.kitsuId = file.kitsuId;
            originalFile.kitsuEpisode = file.kitsuEpisode;
            return originalFile;
          }
        }
        return file;
      }))
      .then(updatedFiles => Promise.all(updatedFiles
          .map(file => file.id ? file.save() : repository.createFile(file))))
      .then(() => console.log(`Updated files for [${torrent.infoHash}] ${torrent.title}`));
}

async function assignSubs() {
  const unassignedSubs = await repository.getUnassignedSubtitles()
      .then(subs => subs.reduce((map, sub) => {
        map[sub.infoHash] = (map[sub.infoHash] || []).concat(sub);
        return map;
      }, {}));
  const infoHashes = Object.keys(unassignedSubs);

  return Promise.all(infoHashes.map(async infoHash => {
    const videos = await repository.getFiles({ infoHash });
    const subtitles = unassignedSubs[infoHash];
    const assignedContents = assignSubtitles({ videos, subtitles });
    return Promise.all(assignedContents.videos
        .filter(video => video.subtitles)
        .map(video => repository.upsertSubtitles(video, video.subtitles)));
  }));
}

async function openTorrentContents() {
  const limiter = new Bottleneck({ maxConcurrent: 15 });
  const unopenedTorrents = await repository.getNoContentsTorrents();

  return Promise.all(unopenedTorrents.map(torrent => limiter.schedule(() => createTorrentContents(torrent))))
      .then(() => unopenedTorrents.length === 500 ? openTorrentContents() : Promise.resolve)
}

// const infoHashes = [
// ]
// Promises.sequence(infoHashes.map(infoHash => () => reapplyEpisodeDecomposing(infoHash)))
//     .then(() => console.log('Finished'));

//findAllFiles().then(() => console.log('Finished'));
//updateMovieCollections().then(() => console.log('Finished'));
reapplyEpisodeDecomposing('96cc18f564f058384c18b4966a183d81808ce3fb', true).then(() => console.log('Finished'));
//reapplySeriesSeasonsSavedAsMovies().then(() => console.log('Finished'));
//reapplyDecomposingToTorrentsOnRegex('.*Title.*').then(() => console.log('Finished'));
//reapplyManualHashes().then(() => console.log('Finished'));
// assignSubs().then(() => console.log('Finished'));
// openTorrentContents().then(() => console.log('Finished'));