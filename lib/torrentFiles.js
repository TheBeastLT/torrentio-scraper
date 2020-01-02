const { torrentFiles } = require('../lib/torrent');
const { escapeTitle, getMetadata, getImdbId } = require('../lib/metadata');
const { parse } = require('parse-torrent-title');
const { Type } = require('./types');

const MIN_SIZE = 20 * 1024 * 1024; // 20 MB

async function parseTorrentFiles(torrent, imdbId) {
  const parsedTorrentName = parse(torrent.title);

  if (torrent.type === Type.MOVIE) {
    if (parsedTorrentName.complete) {
      return torrentFiles(torrent)
          .then(files => files.filter(file => file.size > MIN_SIZE))
          .then(files => Promise.all(files
              .map((file) => findMovieImdbId(file.name)
                  .then((newImdbId) => ({
                    infoHash: torrent.infoHash,
                    fileIndex: file.fileIndex,
                    title: file.name,
                    size: file.size,
                    imdbId: newImdbId,
                  })))))
          .catch(error => {
            console.log(`Failed getting files for ${torrent.title}`, error.message);
            return [];
          });
    }

    return [{
      infoHash: torrent.infoHash,
      title: torrent.title,
      size: torrent.size,
      imdbId: imdbId,
    }];
  }

  if (parsedTorrentName.season && parsedTorrentName.episode) {
    return [{
      infoHash: torrent.infoHash,
      title: torrent.title,
      size: torrent.size,
      imdbId: imdbId,
      imdbSeason: parsedTorrentName.season,
      imdbEpisode: parsedTorrentName.episode
    }];
  }

  parsedTorrentName.hasMovies = parsedTorrentName.complete || !!torrent.title.match(/movies?(?:\W|$)/);
  return torrentFiles(torrent)
      .then((files) => files
          .filter((file) => file.size > MIN_SIZE)
          .map((file) => parseSeriesFile(file, parsedTorrentName)))
      .then((files) => decomposeAbsoluteEpisodes(files, torrent, imdbId))
      .then((files) => Promise.all(files.map(file => file.isMovie
          ? mapSeriesMovie(file, torrent.infoHash)
          : mapSeriesEpisode(file, torrent.infoHash, imdbId))))
      .then((files) => files.reduce((a, b) => a.concat(b), []))
      .catch((error) => {
        console.log(`Failed getting files for ${torrent.title}`, error.message);
        return [];
      });
}

async function mapSeriesEpisode(file, infoHash, imdbId) {
  if (!file.episodes) {
    return Promise.resolve([]);
  }
  return Promise.resolve(file.episodes.map(episode => ({
    infoHash: infoHash,
    fileIndex: file.fileIndex,
    title: file.name,
    size: file.size,
    imdbId: imdbId,
    imdbSeason: file.season,
    imdbEpisode: episode})))
}

async function mapSeriesMovie(file, infoHash) {
  return findMovieImdbId(file).then((imdbId) => [{
    infoHash: infoHash,
    fileIndex: file.fileIndex,
    title: file.name,
    size: file.size,
    imdbId: imdbId
  }])
}

function parseSeriesFile(file, parsedTorrentName) {
  const fileInfo = parse(file.name);
  // the episode may be in a folder containing season number
  if (!fileInfo.season && parsedTorrentName.season) {
    fileInfo.season = parsedTorrentName.season;
  } else if (!fileInfo.season && file.path.includes('/')) {
    const folders = file.path.split('/');
    const pathInfo = parse(folders[folders.length - 2]);
    fileInfo.season = pathInfo.season;
  }
  fileInfo.isMovie = parsedTorrentName.hasMovies && !fileInfo.season && !fileInfo.episodes || !!fileInfo.year;

  return { ...file, ...fileInfo };
}

function findMovieImdbId(title) {
  const parsedTitle = typeof title === 'string' ? parse(title) : title;
  const searchQuery = {
    name: escapeTitle(parsedTitle.title).toLowerCase(),
    year: parsedTitle.year,
    type: Type.MOVIE
  };
  return getImdbId(searchQuery).catch((error) => undefined);
}

async function decomposeAbsoluteEpisodes(files, torrent, imdbId) {
  if (files.every((file) => !file.episodes || file.episodes.every((ep) => ep < 100))) {
    return files; // nothing to decompose
  }

  const metadata = await getMetadata(imdbId, torrent.type || Type.MOVIE);
  // decompose if season is inside path, but individual files are concatenated ex. 101 (S01E01)
  files
      .filter(file => file.season && metadata.episodeCount[file.season] < 100)
      .filter(file => file.episodes && file.episodes.every(ep => ep / 100 === file.season))
      .forEach(file => file.episodes = file.episodes.map(ep => ep % 100));
  // decompose if no season info is available, but individual files are concatenated ex. 101 (S01E01)
  // based on total episodes count per season

  return files;
}

module.exports = { parseTorrentFiles };