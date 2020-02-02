const { torrentFiles } = require('../lib/torrent');
const { escapeTitle, getMetadata, getImdbId } = require('../lib/metadata');
const { parse } = require('parse-torrent-title');
const { Type } = require('./types');

const MIN_SIZE = 20 * 1024 * 1024; // 20 MB

async function parseTorrentFiles(torrent, imdbId, kitsuId) {
  const parsedTorrentName = parse(torrent.title);
  parsedTorrentName.hasMovies = parsedTorrentName.complete || !!torrent.title.match(/movies?(?:\W|$)/);
  const metadata = await getMetadata(kitsuId || imdbId, torrent.type || Type.MOVIE).catch(() => undefined);

  // if (metadata && metadata.type !== torrent.type && torrent.type !== Type.ANIME) {
  //   throw new Error(`Mismatching entry type for ${torrent.name}: ${torrent.type}!=${metadata.type}`);
  // }

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
      imdbId: imdbId || metadata && metadata.imdb_id,
      kitsuId: kitsuId || metadata && metadata.kitsu_id
    }];
  }

  return getSeriesFiles(torrent, parsedTorrentName)
      .then((files) => files
          .filter((file) => file.size > MIN_SIZE)
          .map((file) => parseSeriesFile(file, parsedTorrentName)))
      .then((files) => decomposeEpisodes(torrent, files, metadata))
      .then((files) => assignKitsuOrImdbEpisodes(files, metadata))
      .then((files) => Promise.all(files.map(file => file.isMovie
          ? mapSeriesMovie(file, torrent.infoHash)
          : mapSeriesEpisode(file, torrent.infoHash, imdbId, kitsuId))))
      .then((files) => files.reduce((a, b) => a.concat(b), []))
      .catch((error) => {
        console.log(`Failed getting files for ${torrent.title}`, error.message);
        return [];
      });
}

async function getSeriesFiles(torrent, parsedTorrentName) {
  if (parsedTorrentName.episode || (!parsedTorrentName.episodes && parsedTorrentName.date)) {
    return [{
      name: torrent.title,
      path: torrent.title,
      size: torrent.size
    }];
  }

  return torrentFiles(torrent);
}

async function mapSeriesEpisode(file, infoHash, imdbId, kitsuId) {
  if (!file.episodes && !file.kitsuEpisodes) {
    return Promise.resolve([]);
  }
  const episodeIndexes = [...(file.episodes || file.kitsuEpisodes).keys()];
  return Promise.resolve(episodeIndexes.map((index) => ({
    infoHash: infoHash,
    fileIndex: file.fileIndex,
    title: file.path || file.name,
    size: file.size,
    imdbId: imdbId || file.imdbId,
    imdbSeason: file.season,
    imdbEpisode: file.episodes && file.episodes[index],
    kitsuId: kitsuId || file.kitsuId,
    kitsuEpisode: file.kitsuEpisodes && file.kitsuEpisodes[index]
  })))
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
  fileInfo.isMovie = (parsedTorrentName.hasMovies && !fileInfo.season && (!fileInfo.episodes || !!fileInfo.year))
      || (!fileInfo.season && !!file.name.match(/\b(?:\d+[ .]movie|movie[ .]\d+)\b/i));

  return { ...file, ...fileInfo };
}

async function decomposeEpisodes(torrent, files, metadata = { episodeCount: {} }) {
  if (files.every(file => !file.episodes)) {
    return files;
  }
  // for anime type episodes are always absolute and for a single season
  if (torrent.type === Type.ANIME) {
    files
        .filter(file => file.episodes)
        .forEach(file => file.season = 1);
    return files;
  }

  const sortedEpisodes = files
      .map(file => !file.isMovie && file.episodes || [])
      .reduce((a, b) => a.concat(b), [])
      .sort((a, b) => a - b);

  if (sortedEpisodes.every(ep => ep > 100)
      && sortedEpisodes.slice(1).some((ep, index) => ep - sortedEpisodes[index] > 10)
      && sortedEpisodes.every(ep => metadata.episodeCount[div100(ep) - 1] >= mod100(ep))
      && files.every(file => !file.season || file.episodes.every(ep => div100(ep) === file.season))) {
    decomposeConcatSeasonAndEpisodeFiles(torrent, files, metadata);
  }

  if ((files.every(file => !file.season) || files.some(file => file.season && file.episodes
      && file.episodes.every(ep => metadata.episodeCount[file.season - 1] < ep)))
      && (sortedEpisodes.length <= 1 || sortedEpisodes.slice(1).every((ep, i) => ep - sortedEpisodes[i] <= 2))) {
    decomposeAbsoluteEpisodeFiles(torrent, files, metadata);
  }

  return files;
}

function decomposeConcatSeasonAndEpisodeFiles(torrent, files, metadata) {
  // decompose concat season and episode files (ex. 101=S01E01) in case:
  // 1. file has a season, but individual files are concatenated with that season (ex. path Season 5/511 - Prize
  // Fighters.avi)
  // 2. file does not have a season and the episode does not go out of range for the concat season
  // episode count
  files
      .filter(file => file.episodes && file.episodes.every(ep => ep > 100))
      .filter(file => metadata.episodeCount[(file.season || div100(file.episodes[0])) - 1] < 100)
      .filter(file => file.season && file.episodes.every(ep => div100(ep) === file.season) || !file.season)
      .forEach(file => {
        file.season = div100(file.episodes[0]);
        file.episodes = file.episodes.map(ep => mod100(ep))
      });

}

function decomposeAbsoluteEpisodeFiles(torrent, files, metadata) {
  files
      .filter(file => file.episodes && !file.isMovie)
      .forEach(file => {
        const seasonIdx = ([...metadata.episodeCount.keys()]
            .find((i) => metadata.episodeCount.slice(0, i + 1).reduce((a, b) => a + b) >= file.episodes[0])
            + 1 || metadata.episodeCount.length) - 1;

        file.season = seasonIdx + 1;
        file.episodes = file.episodes
            .map(ep => ep - metadata.episodeCount.slice(0, seasonIdx).reduce((a, b) => a + b, 0))
      });
}

function assignKitsuOrImdbEpisodes(files, metadata) {
  if (!metadata || !metadata.videos || !metadata.videos.length) {
    return files;
  }

  const seriesMapping = metadata.videos
      .reduce((map, video) => {
        const episodeMap = map[video.season] || {};
        episodeMap[video.episode] = video;
        map[video.season] = episodeMap;
        return map;
      }, {});

  if (metadata.videos.some(video => video.imdbSeason) || !metadata.imdbId) {
    // kitsu episode info is the base
    files
        .filter(file => file.season && file.episodes)
        .map(file => {
          const seasonMapping = seriesMapping[file.season];
          file.kitsuEpisodes = file.episodes;
          if (seasonMapping && seasonMapping[file.episodes[0]] && seasonMapping[file.episodes[0]].imdbSeason) {
            file.imdbId = metadata.imdbId;
            file.season = seasonMapping[file.episodes[0]].imdbSeason;
            file.episodes = file.episodes.map(ep => seasonMapping[ep] && seasonMapping[ep].imdbEpisode);
          } else {
            // no imdb mapping available for episode
            file.season = undefined;
            file.episodes = undefined;
          }
        })
  } else if (metadata.videos.some(video => video.kitsuEpisode)) {
    // imdb episode info is base
    files
        .filter(file => file.season && file.episodes)
        .forEach(file => {
          const seasonMapping = seriesMapping[file.season];
          if (seasonMapping && seasonMapping[file.episodes[0]] && seasonMapping[file.episodes[0]].kitsuId) {
            file.kitsuId = seasonMapping[file.episodes[0]].kitsuId;
            file.kitsuEpisodes = file.episodes.map(ep => seasonMapping[ep] && seasonMapping[ep].kitsuEpisode);
          }
        })
  }
  return files;
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

function div100(episode) {
  return (episode / 100 >> 0); // floor to nearest int
}

function mod100(episode) {
  return episode % 100;
}

module.exports = { parseTorrentFiles };