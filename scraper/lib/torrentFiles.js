const moment = require('moment');
const distance = require('jaro-winkler');
const { parse } = require('parse-torrent-title');
const { torrentFiles } = require('../lib/torrent');
const { getMetadata, getImdbId } = require('../lib/metadata');
const { Type } = require('./types');

const MIN_SIZE = 10 * 1024 * 1024; // 10 MB

async function parseTorrentFiles(torrent) {
  const parsedTorrentName = parse(torrent.title);
  parsedTorrentName.hasMovies = parsedTorrentName.complete || !!torrent.title.match(/movies?(?:\W|$)/i);
  const metadata = await getMetadata(torrent.kitsuId || torrent.imdbId, torrent.type || Type.MOVIE)
      .catch(() => undefined);

  // if (metadata && metadata.type !== torrent.type && torrent.type !== Type.ANIME) {
  //   throw new Error(`Mismatching entry type for ${torrent.name}: ${torrent.type}!=${metadata.type}`);
  // }
  if (torrent.type === Type.SERIES && metadata && metadata.type === Type.MOVIE) {
    // it's actually a movie
    torrent.type = Type.MOVIE;
  }

  if (torrent.type === Type.MOVIE && !parsedTorrentName.seasons || metadata && metadata.type === Type.MOVIE) {
    if (parsedTorrentName.complete || typeof parsedTorrentName.year === 'string') {
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
      imdbId: torrent.imdbId || metadata && metadata.imdbId,
      kitsuId: torrent.kitsuId || metadata && metadata.kitsuId
    }];
  }

  // const parsedSeriesTorrentName = seriesParser.parse(torrent.title);
  // parsedTorrentName.episodes = parsedSeriesTorrentName.episodes;
  // parsedTorrentName.episode = parsedSeriesTorrentName.episode;
  return getSeriesFiles(torrent, parsedTorrentName)
      .then((files) => files
          .filter((file) => file.size > MIN_SIZE)
          .map((file) => parseSeriesFile(file, parsedTorrentName)))
      .then((files) => decomposeEpisodes(torrent, files, metadata))
      .then((files) => assignKitsuOrImdbEpisodes(torrent, files, metadata))
      .then((files) => Promise.all(files.map(file => file.isMovie
          ? mapSeriesMovie(file, torrent)
          : mapSeriesEpisode(file, torrent, files))))
      .then((files) => files.reduce((a, b) => a.concat(b), []))
      .catch((error) => {
        console.log(`Failed getting files for ${torrent.title}`, error.message);
        return [];
      });
}

async function getSeriesFiles(torrent, parsedTorrentName) {
  if (!parsedTorrentName.complete && !parsedTorrentName.hasMovies &&
      ((parsedTorrentName.episode && (!parsedTorrentName.seasons || parsedTorrentName.seasons.length <= 1)) ||
          (!parsedTorrentName.episodes && parsedTorrentName.date))) {
    return [{
      name: torrent.title,
      path: torrent.title,
      size: torrent.size
    }];
  }

  return torrentFiles(torrent);
}

async function mapSeriesEpisode(file, torrent, files) {
  if (!file.episodes && !file.kitsuEpisodes) {
    if (files.some(otherFile => otherFile.episodes || otherFile.kitsuEpisodes) || parse(torrent.title).seasons) {
      return Promise.resolve({
        infoHash: torrent.infoHash,
        fileIndex: file.fileIndex,
        title: file.path || file.name,
        size: file.size,
        imdbId: torrent.imdbId || file.imdbId,
      });
    }
    return Promise.resolve([]);
  }
  const episodeIndexes = [...(file.episodes || file.kitsuEpisodes).keys()];
  return Promise.resolve(episodeIndexes.map((index) => ({
    infoHash: torrent.infoHash,
    fileIndex: file.fileIndex,
    title: file.path || file.name,
    size: file.size,
    imdbId: torrent.imdbId || file.imdbId,
    imdbSeason: file.season,
    imdbEpisode: file.episodes && file.episodes[index],
    kitsuId: torrent.kitsuId || file.kitsuId,
    kitsuEpisode: file.kitsuEpisodes && file.kitsuEpisodes[index]
  })))
}

async function mapSeriesMovie(file, torrent) {
  return findMovieImdbId(file).then((imdbId) => [{
    infoHash: torrent.infoHash,
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
  // force episode to any found number if it was not parsed
  if (!fileInfo.episodes && !fileInfo.date) {
    const epMatcher = fileInfo.title.match(/(?<!movie\W*|film\W*)(?:^|\W)(\d{1,4})(?:a|b|v\d)?(?:\W|$)(?!movie|film)/i);
    fileInfo.episodes = epMatcher && [parseInt(epMatcher[1], 10)];
    fileInfo.episode = fileInfo.episodes && fileInfo.episodes[0];
  }
  fileInfo.isMovie = (parsedTorrentName.hasMovies && !fileInfo.season && (!fileInfo.episodes || !!fileInfo.year))
      || (!fileInfo.season && !!file.name.match(/\b(?:\d+[ .]movie|movie[ .]\d+)\b/i));

  return { ...file, ...fileInfo };
}

async function decomposeEpisodes(torrent, files, metadata = { episodeCount: [] }) {
  if (files.every(file => !file.episodes && !file.date)) {
    return files;
  }
  // for anime type episodes are always absolute and for a single season
  if (torrent.type === Type.ANIME && torrent.kitsuId) {
    files
        .filter(file => file.episodes)
        .forEach(file => file.season = 1);
    return files;
  }

  const sortedEpisodes = files
      .map(file => !file.isMovie && file.episodes || [])
      .reduce((a, b) => a.concat(b), [])
      .sort((a, b) => a - b);

  if (isConcatSeasonAndEpisodeFiles(files, sortedEpisodes, metadata)) {
    decomposeConcatSeasonAndEpisodeFiles(torrent, files, metadata);
  } else if (isDateEpisodeFiles(files, metadata)) {
    decomposeDateEpisodeFiles(torrent, files, metadata);
  } else if (isAbsoluteEpisodeFiles(files, metadata)) {
    decomposeAbsoluteEpisodeFiles(torrent, files, metadata);
  }
  // decomposeEpisodeTitleFiles(torrent, files, metadata);

  return files;
}

function isConcatSeasonAndEpisodeFiles(files, sortedEpisodes, metadata) {
  // decompose concat season and episode files (ex. 101=S01E01) in case:
  // 1. file has a season, but individual files are concatenated with that season (ex. path Season 5/511 - Prize
  // Fighters.avi)
  // 2. file does not have a season and the episode does not go out of range for the concat season
  // episode count
  return sortedEpisodes.every(ep => ep > 100)
      && sortedEpisodes.slice(1).some((ep, index) => ep - sortedEpisodes[index] > 10)
      && sortedEpisodes.every(ep => metadata.episodeCount[div100(ep) - 1] >= mod100(ep))
      && files.every(file => !file.season || file.episodes.every(ep => div100(ep) === file.season))
}

function isDateEpisodeFiles(files, metadata) {
  return files.every(file => (!file.season || !metadata.episodeCount[file.season - 1]) && file.date);
}

function isAbsoluteEpisodeFiles(files, metadata) {
  return (files.filter(file => !file.isMovie && file.episodes).every(file => !file.season && file.episodes)
      || files.filter(file => file.season && file.episodes && file.episodes
          .every(ep => metadata.episodeCount[file.season - 1] < ep)).length > Math.ceil(files.length / 5))
  // && !isNewEpisodesNotInMetadata(files, metadata);
}

function isNewEpisodesNotInMetadata(files, metadata) {
  // new episode might not yet been indexed by cinemeta.
  // detect this if episode number is larger than the last episode or season is larger than the last one
  return files.length === 1
      && /continuing|current/i.test(metadata.status)
      && files.filter(file => !file.isMovie && file.episodes)
          .every(file => file.season >= metadata.episodeCount.length
              && file.episodes.every(ep => ep > metadata.episodeCount[file.season - 1]))
}

function decomposeConcatSeasonAndEpisodeFiles(torrent, files, metadata) {
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
  if (metadata.episodeCount.length === 0) {
    files
        .filter(file => !file.season && file.episodes && !file.isMovie)
        .forEach(file => {
          file.season = 1;
        });
    return;
  }
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

function decomposeDateEpisodeFiles(torrent, files, metadata) {
  if (!metadata || !metadata.videos || !metadata.videos.length) {
    return;
  }

  const timeZoneOffset = getTimeZoneOffset(metadata.country);
  const offsetVideos = metadata.videos
      .reduce((map, video) => {
        const releaseDate = moment(video.released).utcOffset(timeZoneOffset).format('YYYY-MM-DD');
        map[releaseDate] = video;
        return map;
      }, {});

  files
      .filter(file => file.date)
      .forEach(file => {
        const video = offsetVideos[file.date];
        if (video) {
          file.season = video.season;
          file.episodes = [video.episode];
        }
      });
}

function decomposeEpisodeTitleFiles(torrent, files, metadata) {
  files
      .filter(file => !file.season)
      .map(file => {
        const episodeTitle = file.name.replace(/^.*-\s?(.+)\.\w{1,4}$/, '$1').trim();
        const foundEpisode = metadata.videos
            .map(video => ({ ...video, distance: distance(episodeTitle, video.name) }))
            .sort((a, b) => b.distance - a.distance)[0];
        if (foundEpisode) {
          file.isMovie = false;
          file.season = foundEpisode.season;
          file.episodes = [foundEpisode.episode];
        }
      })
}

function getTimeZoneOffset(country) {
  switch (country) {
    case 'USA':
      return '-08:00';
    default:
      return '00:00';
  }
}

function assignKitsuOrImdbEpisodes(torrent, files, metadata) {
  if (!metadata || !metadata.videos || !metadata.videos.length) {
    if (torrent.type === Type.ANIME) {
      // assign episodes as kitsu episodes for anime when no metadata available for imdb mapping
      files
          .filter(file => file.season && file.episodes)
          .forEach(file => {
            file.kitsuEpisodes = file.episodes;
            file.season = undefined;
            file.episodes = undefined;
          })
    }
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
  return getImdbId(parsedTitle, Type.MOVIE).catch(() => undefined);
}

function div100(episode) {
  return (episode / 100 >> 0); // floor to nearest int
}

function mod100(episode) {
  return episode % 100;
}

module.exports = { parseTorrentFiles };