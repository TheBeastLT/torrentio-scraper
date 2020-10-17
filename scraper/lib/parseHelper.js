const { parse } = require('parse-torrent-title');
const { Type } = require('./types');

function parseSeriesVideos(torrent, videos) {
  const parsedTorrentName = parse(torrent.title);
  const hasMovies = parsedTorrentName.complete || !!torrent.title.match(/movies?(?:\W|$)/i);
  const parsedVideos = videos.map(video => parseSeriesVideo(video, parsedTorrentName));
  return parsedVideos.map(video => ({ ...video, isMovie: isMovieVideo(video, parsedVideos, torrent.type, hasMovies) }));
}

function parseSeriesVideo(video, parsedTorrentName) {
  const videoInfo = parse(video.name);
  // the episode may be in a folder containing season number
  if (!videoInfo.season && video.path.includes('/')) {
    const folders = video.path.split('/');
    const pathInfo = parse(folders[folders.length - 2]);
    videoInfo.season = pathInfo.season;
  }
  if (!videoInfo.season && parsedTorrentName.season) {
    videoInfo.season = parsedTorrentName.season;
  }
  if (!videoInfo.season && videoInfo.seasons && videoInfo.seasons.length > 1) {
    // in case single file was interpreted as having multiple seasons
    videoInfo.season = videoInfo.seasons[0];
  }
  // sometimes video file does not have correct date format as in torrent title
  if (!videoInfo.episodes && !videoInfo.date && parsedTorrentName.date) {
    videoInfo.date = parsedTorrentName.date;
  }
  // force episode to any found number if it was not parsed
  if (!videoInfo.episodes && !videoInfo.date) {
    const epMatcher = videoInfo.title.match(
        /(?<!season\W*|disk\W*|movie\W*|film\W*)(?:^|\W)(\d{1,4})(?:a|b|c|v\d)?(?:\W|$)(?!disk|movie|film)/i);
    videoInfo.episodes = epMatcher && [parseInt(epMatcher[1], 10)];
    videoInfo.episode = videoInfo.episodes && videoInfo.episodes[0];
  }

  return { ...video, ...videoInfo };
}

function isMovieVideo(video, otherVideos, type, hasMovies) {
  if (Number.isInteger(video.season)) {
    // not movie if video has season
    return false;
  }
  if (video.name.match(/\b(?:\d+[ .]movie|movie[ .]\d+)\b/i)) {
    // movie if video explicitly has numbered movie keyword in the name, ie. 1 Movie or Movie 1
    return true;
  }
  if (!hasMovies && type !== Type.ANIME) {
    // not movie if torrent name does not contain movies keyword or is not a pack torrent and is not anime
    return false;
  }
  if (!video.episodes) {
    // movie if there's no episode info it could be a movie
    return true;
  }
  // movie if contains year info and there aren't more than 3 video with same title and year
  // as some series titles might contain year in it.
  return !!video.year
      && otherVideos.length > 3
      && otherVideos.filter(other => other.title === video.title && other.year === video.year) < 3;
}

module.exports = { parseSeriesVideos }