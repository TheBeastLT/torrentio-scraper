const { parse } = require('parse-torrent-title');

function assignSubtitles({ contents, videos, subtitles }) {
  if (videos && videos.length && subtitles && subtitles.length) {
    if (videos.length === 1) {
      videos[0].subtitles = subtitles;
      return { contents, videos, subtitles: [] };
    }

    const parsedVideos = videos
        .map(video => _parseVideo(video));
    const assignedSubs = subtitles
        .map(subtitle => ({ subtitle, video: _mostProbableSubtitleVideo(subtitle, parsedVideos) }));
    const unassignedSubs = assignedSubs.filter(assignedSub => !assignedSub.video);

    assignedSubs
        .filter(assignedSub => assignedSub.video)
        .forEach(assignedSub =>
            assignedSub.video.subtitles = (assignedSub.video.subtitles || []).concat(assignedSub.subtitle))
    return { contents, videos, subtitles: unassignedSubs };
  }
  return { contents, videos, subtitles };
}

function _parseVideo(video) {
  const fileName = video.title.replace(/\.(\w{2,4})$/, '');
  const folderName = video.title.replace(/\/?[^/]+$/, '');
  return {
    videoFile: video,
    fileName: fileName,
    folderName: folderName,
    ...parse(fileName)
  };
}

function _mostProbableSubtitleVideo(subtitle, parsedVideos) {
  const subTitle = subtitle.title || subtitle.path;
  const parsedSub = parse(subTitle.replace(/\.(\w{2,4})$/, ''));
  const byFileName = parsedVideos.filter(video => subTitle.includes(video.fileName));
  if (byFileName.length === 1) {
    return byFileName[0].videoFile;
  }
  const byTitleSeasonEpisode = parsedVideos.filter(video => video.title === parsedSub.title
      && video.seasons === parsedSub.seasons
      && JSON.stringify(video.episodes) === JSON.stringify(parsedSub.episodes));
  if (byTitleSeasonEpisode.length === 1) {
    return byTitleSeasonEpisode[0].videoFile;
  }
  const bySeasonEpisode = parsedVideos.filter(video => video.seasons === parsedSub.seasons
      && video.episodes === parsedSub.episodes);
  if (bySeasonEpisode.length === 1) {
    return bySeasonEpisode[0].videoFile;
  }
  const byTitle = parsedVideos.filter(video => video.title && video.title === parsedSub.title);
  if (byTitle.length === 1) {
    return byTitle[0].videoFile;
  }
  const byEpisode = parsedVideos.filter(video => JSON.stringify(video.episodes) === JSON.stringify(parsedSub.episodes));
  if (byEpisode.length === 1) {
    return byEpisode[0].videoFile;
  }
  return undefined;
}

module.exports = { assignSubtitles }