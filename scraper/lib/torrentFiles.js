const moment = require('moment');
const distance = require('jaro-winkler');
const { parse } = require('parse-torrent-title');
const Promises = require('../lib/promises');
const { torrentFiles } = require('../lib/torrent');
const { getMetadata, getImdbId, getKitsuId } = require('../lib/metadata');
const { parseSeriesVideos } = require('../lib/parseHelper');
const { Type } = require('./types');
const { isDisk } = require('./extension');

const MIN_SIZE = 10 * 1024 * 1024; // 10 MB
const MULTIPLE_FILES_SIZE = 4 * 1024 * 1024 * 1024; // 4 GB

async function parseTorrentFiles(torrent) {
  const parsedTorrentName = parse(torrent.title);
  const metadata = await getMetadata(torrent.kitsuId || torrent.imdbId, torrent.type || Type.MOVIE)
      .then(meta => Object.assign({}, meta))
      .catch(() => undefined);

  // if (metadata && metadata.type !== torrent.type && torrent.type !== Type.ANIME) {
  //   throw new Error(`Mismatching entry type for ${torrent.name}: ${torrent.type}!=${metadata.type}`);
  // }
  if (torrent.type === Type.SERIES && metadata && metadata.type === Type.MOVIE) {
    // it's actually a movie
    torrent.type = Type.MOVIE;
  }

  if (torrent.type === Type.MOVIE && (!parsedTorrentName.seasons ||
      parsedTorrentName.season === 5 && [1, 5].includes(parsedTorrentName.episode))) {
    return parseMovieFiles(torrent, parsedTorrentName, metadata);
  }

  return parseSeriesFiles(torrent, parsedTorrentName, metadata)
}

async function parseMovieFiles(torrent, parsedName, metadata) {
  const { contents, videos, subtitles } = await getMoviesTorrentContent(torrent, parsedName);
  const filteredVideos = videos
      .filter(video => video.size > MIN_SIZE)
      .filter(video => !isFeaturette(video));
  if (isSingleMovie(filteredVideos)) {
    const parsedVideos = filteredVideos.map(video => ({
      infoHash: torrent.infoHash,
      fileIndex: video.fileIndex,
      title: video.path || torrent.title,
      size: video.size || torrent.size,
      imdbId: torrent.imdbId || metadata && metadata.imdbId,
      kitsuId: torrent.kitsuId || metadata && metadata.kitsuId
    }));
    return { contents, videos: parsedVideos, subtitles };
  }

  const parsedVideos = await Promises.sequence(filteredVideos
      .map(video => () => isFeaturette(video)
          ? Promise.resolve(video)
          : findMovieImdbId(video.name).then(imdbId => ({ ...video, imdbId }))))
      .then(videos => videos.map(video => ({
        infoHash: torrent.infoHash,
        fileIndex: video.fileIndex,
        title: video.path || video.name,
        size: video.size,
        imdbId: video.imdbId,
      })));
  return { contents, videos: parsedVideos, subtitles };
}

async function parseSeriesFiles(torrent, parsedName, metadata) {
  const { contents, videos, subtitles } = await getSeriesTorrentContent(torrent, parsedName);
  const parsedVideos = await Promise.resolve(videos)
      .then(videos => videos.filter(video => videos.length === 1 || video.size > MIN_SIZE))
      .then(videos => parseSeriesVideos(torrent, videos))
      .then(videos => decomposeEpisodes(torrent, videos, metadata))
      .then(videos => assignKitsuOrImdbEpisodes(torrent, videos, metadata))
      .then(videos => Promise.all(videos.map(video => video.isMovie
          ? mapSeriesMovie(video, torrent)
          : mapSeriesEpisode(video, torrent, videos))))
      .then(videos => videos
          .reduce((a, b) => a.concat(b), [])
          .map(video => isFeaturette(video) ? clearInfoFields(video) : video))
  return { contents, videos: parsedVideos, subtitles };
}

async function getMoviesTorrentContent(torrent, parsedName) {
  const hasMultipleMovie = parsedName.complete || typeof parsedName.year === 'string';
  const files = await torrentFiles(torrent)
      .catch(error => {
        if (!hasMultipleMovie) {
          return { videos: [{ name: torrent.title, path: torrent.title, size: torrent.size }] }
        }
        return Promise.reject(error);
      });
  if (files.contents && files.contents.length && !files.length && isDiskTorrent(files.contents)) {
    files.videos = [{ name: torrent.title, path: torrent.title, size: torrent.size }];
  }
  return files;
}

async function getSeriesTorrentContent(torrent, parsedName) {
  const hasMultipleEpisodes = parsedName.complete || torrent.size > MULTIPLE_FILES_SIZE ||
      (parsedName.seasons && parsedName.seasons.length > 1);
  const hasSingleEpisode = Number.isInteger(parsedName.episode) || (!parsedName.episodes && parsedName.date);
  return torrentFiles(torrent)
      .catch(error => {
        if (!hasMultipleEpisodes && hasSingleEpisode) {
          return { videos: [{ name: torrent.title, path: torrent.title, size: torrent.size }] }
        }
        return Promise.reject(error);
      });
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
    imdbId: file.imdbId || torrent.imdbId,
    imdbSeason: file.season,
    imdbEpisode: file.episodes && file.episodes[index],
    kitsuId: file.kitsuId || torrent.kitsuId,
    kitsuEpisode: file.kitsuEpisodes && file.kitsuEpisodes[index]
  })))
}

async function mapSeriesMovie(file, torrent) {
  const kitsuId = torrent.type === Type.ANIME ? await findMovieKitsuId(file) : undefined;
  const imdbId = !kitsuId ? await findMovieImdbId(file) : undefined;
  const metadata = await getMetadata(kitsuId || imdbId, Type.MOVIE).catch(() => undefined);
  return [{
    infoHash: torrent.infoHash,
    fileIndex: file.fileIndex,
    title: file.path || file.name,
    size: file.size,
    imdbId: metadata && metadata.imdbId || imdbId,
    kitsuId: metadata && metadata.kitsuId || kitsuId
  }];
}

async function decomposeEpisodes(torrent, files, metadata = { episodeCount: [] }) {
  if (files.every(file => !file.episodes && !file.date)) {
    return files;
  }

  preprocessEpisodes(files);

  if (torrent.type === Type.ANIME && torrent.kitsuId) {
    if (needsCinemetaMetadataForAnime(files, metadata)) {
      // In some cases anime could be resolved to wrong kitsuId
      // because of imdb season naming/absolute per series naming/multiple seasons
      // So in these cases we need to fetch cinemeta based metadata and decompose episodes using that
      await updateToCinemetaMetadata(metadata);
      if (files.some(file => Number.isInteger(file.season))) {
        // sometimes multi season anime torrents don't include season 1 naming
        files
            .filter(file => !Number.isInteger(file.season) && file.episodes)
            .forEach(file => file.season = 1);
      }
    } else {
      // otherwise for anime type episodes are always absolute and for a single season
      files
          .filter(file => file.episodes)
          .forEach(file => file.season = 1);
      return files;
    }
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

function preprocessEpisodes(files) {
  // reverse special episode naming when they named with 0 episode, ie. S02E00
  files
      .filter(file => Number.isInteger(file.season) && file.episode === 0)
      .forEach(file => {
        file.episode = file.season
        file.episodes = [file.season]
        file.season = 0;
      })
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
  const threshold = Math.ceil(files.length / 5);
  const nonMovieEpisodes = files
      .filter(file => !file.isMovie && file.episodes);
  const absoluteEpisodes = files
      .filter(file => file.season && file.episodes)
      .filter(file => file.episodes.every(ep => metadata.episodeCount[file.season - 1] < ep))
  return nonMovieEpisodes.every(file => !Number.isInteger(file.season)) || absoluteEpisodes.length > threshold
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
      // .filter(file => !file.season)
      .map(file => {
        const episodeTitle = file.name.replace('_', ' ')
            .replace(/^.*(?:E\d+[abc]?|- )\s?(.+)\.\w{1,4}$/, '$1')
            .trim();
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
      if (metadata.type === Type.MOVIE && files.every(file => !file.imdbId)) {
        // sometimes a movie has episode naming, thus not recognized as a movie and imdbId not assigned
        files.forEach(file => file.imdbId = metadata.imdbId);
      }
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
        });
  } else if (metadata.videos.some(video => video.kitsuEpisode)) {
    // imdb episode info is base
    files
        .filter(file => file.season && file.episodes)
        .forEach(file => {
          if (seriesMapping[file.season]) {
            const seasonMapping = seriesMapping[file.season];
            file.imdbId = metadata.imdbId;
            file.kitsuId = seasonMapping[file.episodes[0]] && seasonMapping[file.episodes[0]].kitsuId;
            file.kitsuEpisodes = file.episodes.map(ep => seasonMapping[ep] && seasonMapping[ep].kitsuEpisode);
          } else if (seriesMapping[file.season - 1]) {
            // sometimes a second season might be a continuation of the previous season
            const seasonMapping = seriesMapping[file.season - 1];
            const episodes = Object.values(seasonMapping);
            const firstKitsuId = episodes.length && episodes[0].kitsuId;
            const differentTitlesCount = new Set(episodes.map(ep => ep.kitsuId)).size
            const skippedCount = episodes.filter(ep => ep.kitsuId === firstKitsuId).length;
            const seasonEpisodes = files
                .filter(otherFile => otherFile.season === file.season)
                .reduce((a, b) => a.concat(b.episodes), []);
            const isAbsoluteOrder = seasonEpisodes.every(ep => ep > skippedCount && ep <= episodes.length)
            const isNormalOrder = seasonEpisodes.every(ep => ep + skippedCount <= episodes.length)
            if (differentTitlesCount >= 1 && (isAbsoluteOrder || isNormalOrder)) {
              file.imdbId = metadata.imdbId;
              file.season = file.season - 1;
              file.episodes = file.episodes.map(ep => isAbsoluteOrder ? ep : ep + skippedCount);
              file.kitsuId = seasonMapping[file.episodes[0]].kitsuId;
              file.kitsuEpisodes = file.episodes.map(ep => seasonMapping[ep] && seasonMapping[ep].kitsuEpisode);
            }
          } else if (Object.values(seriesMapping).length === 1 && seriesMapping[1]) {
            // sometimes series might be named with sequel season but it's not a season on imdb and a new title
            const seasonMapping = seriesMapping[1];
            file.imdbId = metadata.imdbId;
            file.season = 1;
            file.kitsuId = seasonMapping[file.episodes[0]].kitsuId;
            file.kitsuEpisodes = file.episodes.map(ep => seasonMapping[ep] && seasonMapping[ep].kitsuEpisode);
          }
        });
  }
  return files;
}

function needsCinemetaMetadataForAnime(files, metadata) {
  if (!metadata || !metadata.imdbId || !metadata.videos || !metadata.videos.length) {
    return false;
  }

  const minSeason = Math.min(...metadata.videos.map(video => video.imdbSeason)) || Number.MAX_VALUE;
  const maxSeason = Math.max(...metadata.videos.map(video => video.imdbSeason)) || Number.MAX_VALUE;
  const differentSeasons = new Set(metadata.videos
      .map(video => video.imdbSeason)
      .filter(season => Number.isInteger(season))).size;
  const total = metadata.totalCount || Number.MAX_VALUE;
  return differentSeasons > 1 || files
      .filter(file => !file.isMovie && file.episodes)
      .some(file => file.season < minSeason || file.season > maxSeason || file.episodes.every(ep => ep > total));
}

async function updateToCinemetaMetadata(metadata) {
  return getMetadata(metadata.imdbId, metadata.type)
      .then(newMetadata => !newMetadata.videos || !newMetadata.videos.length ? metadata : newMetadata)
      .then(newMetadata => {
        metadata.videos = newMetadata.videos;
        metadata.episodeCount = newMetadata.episodeCount;
        metadata.totalCount = newMetadata.totalCount;
        return metadata;
      })
      .catch(error => console.warn(`Failed ${metadata.imdbId} metadata cinemeta update due: ${error.message}`));
}

function findMovieImdbId(title) {
  const parsedTitle = typeof title === 'string' ? parse(title) : title;
  return getImdbId(parsedTitle, Type.MOVIE).catch(() => undefined);
}

function findMovieKitsuId(title) {
  const parsedTitle = typeof title === 'string' ? parse(title) : title;
  return getKitsuId(parsedTitle, Type.MOVIE).catch(() => undefined);
}

function isDiskTorrent(contents) {
  return contents.some(content => isDisk(content.path));
}

function isSingleMovie(videos) {
  return videos.length === 1 ||
      (videos.length === 2 &&
          videos.find(v => /\bcd[ .-]?0?1\b/i.test(v.path)) &&
          videos.find(v => /\bcd[ .-]?0?2\b/i.test(v.path)));
}

function isFeaturette(video) {
  return /featurettes?\/|extras-grym/i.test(video.path);
}

function clearInfoFields(video) {
  video.imdbId = undefined;
  video.imdbSeason = undefined;
  video.imdbEpisode = undefined;
  video.kitsuId = undefined;
  video.kitsuEpisode = undefined;
  return video;
}

function div100(episode) {
  return (episode / 100 >> 0); // floor to nearest int
}

function mod100(episode) {
  return episode % 100;
}

module.exports = { parseTorrentFiles };