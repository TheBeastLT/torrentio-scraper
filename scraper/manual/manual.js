const Bottleneck = require('bottleneck');
const { parse } = require('parse-torrent-title');
const { mostCommonValue } = require('../lib/promises');
const repository = require('../lib/repository');
const { getImdbId } = require('../lib/metadata');
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
      : mostCommonValue(storedFiles.map(file => file.imdbId)) || await getImdbId(parse(torrent.title));

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

async function findAllFiles() {
  /* Test cases */
  /* Anime Season and absolute episodes */
  const torrent = {
    infoHash: '6b95e5cfde9aaa71970a14f6bb6b9de19e2cbfa1',
    title: '[OMDA] Bleach + Filmes + Ovas (480p-720p x264 AAC-MP3) [rich_jc]',
    type: Type.SERIES,
    imdbId: 'tt0434665'
  };
  /* Season and concat episodes */
  // const torrent = {
  //   infoHash: '235e8ed73b6cc9679b0842c39e17223c47b51f68',
  //   title: 'Daria - The Complete Animated Series [2010] DVDRip',
  //   type: Type.SERIES,
  //   imdbId: 'tt0118298'
  // };
  /* Series Season and absolute episodes */
  // const torrent = {
  //   infoHash: '16b4560beb05397c0eeb35487a997caf789243ea',
  //   title: 'Seinfeld - Complete Collection',
  //   type: Type.SERIES,
  //   imdbId: 'tt0098904'
  // };
  /* Series Season and episodes */
  // const torrent = {
  //   infoHash: 'd0f120c1bbfb988eb35b648e1c78ca3e5d45ef39',
  //   title: 'Seinfeld Complete Series-720p WEBrip EN-SUB x264-[MULVAcoded]',
  //   type: Type.SERIES,
  //   imdbId: 'tt0098904'
  // };
  /* Anime single absolute episode */
  // const torrent = {
  //   infoHash: 'e81e12880980086c476aa8bfdd22bed9d41b1dfe',
  //   title: '[Vision] Naruto Shippuuden - 451 (1080p x264 AAC) [rich_jc].mp4',
  //   size: 467361138,
  //   type: Type.SERIES,
  //   imdbId: 'tt0988824'
  // };
  /* Date based episode */
  // const torrent = {
  //   infoHash: '5a8e9e64fa04e3541236f049cb6b0d35e4ca12cc',
  //   title: 'Jimmy.Fallon.2020.02.14.Steve.Buscemi.WEB.x264-XLF[TGx]',
  //   size: 618637331,
  //   type: Type.SERIES,
  //   imdbId: 'tt3444938'
  // };
  /* Not all seasons available so Date based episode */
  // const torrent = {
  //   infoHash: 'DCD5ACF85F4203FE14428A890528B2EDBD07B092',
  //   title: 'The Young And The Restless - S43 E10986 - 2016-08-12',
  //   size: 989777743,
  //   type: Type.SERIES,
  //   imdbId: 'tt0069658'
  // };
  // const torrent = {
  //   infoHash: 'C75FBDCD62EB882746A0E58B19BADD60DE14526B',
  //   title: 'Jimmy.Kimmel.2016.08.03.Hugh.Grant.480p.x264-mSD',
  //   size: 618637331,
  //   type: Type.SERIES,
  //   imdbId: 'tt0320037'
  // };
  /* With extras exceeding season episode count */
  // const torrent = {
  //   infoHash: '2af56a80357b61d839328b986d1165ea8395bbc0',
  //   title: 'Tim and Eric - Complete',
  //   type: Type.SERIES,
  //   imdbId: 'tt0912343'
  // };
  /* With two anime seasons counted as one season  */
  // const torrent = {
  //   infoHash: 'ea02b20a87df600c11d2b405e52813de5d431102',
  //   title: '[zza] No Guns Life - (S01-S02) [1080p.x265][multisubs:eng,fre][Vostfr]',
  //   type: Type.ANIME,
  //   kitsuId: 42197
  // };
  /* With two anime seasons in absolute order counted as one season  */
  // const torrent = {
  //   infoHash: '8b894d747451d50a3bd8d8fd962e4d49da6850ec',
  //   title: '[JacobSwaggedUp] Gate | Gate: Jieitai Kanochi nite, Kaku Tatakaeri | Gate: Thus the JSDF Fought There! -
  // Complete (BD 1280x720) [MP4 Batch]',  type: Type.ANIME,  kitsuId: 10085  };

  return parseTorrentFiles(torrent)
      .then((files) => console.log(files.videos));
}

//findAllFiles().then(() => console.log('Finished'));
//updateMovieCollections().then(() => console.log('Finished'));
reapplyEpisodeDecomposing('9bfabed62825874d2f2150ffb45c533f48636222', false).then(() => console.log('Finished'));
//reapplySeriesSeasonsSavedAsMovies().then(() => console.log('Finished'));
//reapplyDecomposingToTorrentsOnRegex('.*Boku no Hero Academia.*').then(() => console.log('Finished'));
//reapplyManualHashes().then(() => console.log('Finished'));
// assignSubs().then(() => console.log('Finished'));
// openTorrentContents().then(() => console.log('Finished'));