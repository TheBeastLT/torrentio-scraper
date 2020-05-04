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
        .map(subtitle => ({ subtitle, videos: _mostProbableSubtitleVideos(subtitle, parsedVideos) }));
    const unassignedSubs = assignedSubs
        .filter(assignedSub => !assignedSub.videos)
        .map(assignedSub => assignedSub.subtitle);

    assignedSubs
        .filter(assignedSub => assignedSub.videos)
        .forEach(assignedSub => assignedSub.videos
            .forEach(video => video.subtitles = (video.subtitles || []).concat(assignedSub.subtitle)));
    return { contents, videos, subtitles: unassignedSubs };
  }
  return { contents, videos, subtitles };
}

function _parseVideo(video) {
  const fileName = video.title.split('/').pop().replace(/\.(\w{2,4})$/, '');
  const folderName = video.title.replace(/\/?[^/]+$/, '');
  return {
    videoFile: video,
    fileName: fileName,
    folderName: folderName,
    ...parse(video.title)
  };
}

function _mostProbableSubtitleVideos(subtitle, parsedVideos) {
  const subTitle = subtitle.title || subtitle.path;
  const parsedSub = parse(subTitle.replace(/\.(\w{2,4})$/, ''));
  const byFileName = parsedVideos.filter(video => subTitle.includes(video.fileName));
  if (byFileName.length === 1) {
    return byFileName.map(v => v.videoFile);
  }
  const byTitleSeasonEpisode = parsedVideos.filter(video => video.title === parsedSub.title
      && video.seasons === parsedSub.seasons
      && JSON.stringify(video.episodes) === JSON.stringify(parsedSub.episodes));
  if (singleVideoFile(byTitleSeasonEpisode)) {
    return byTitleSeasonEpisode.map(v => v.videoFile);
  }
  const bySeasonEpisode = parsedVideos.filter(video => video.seasons === parsedSub.seasons
      && video.episodes === parsedSub.episodes);
  if (singleVideoFile(bySeasonEpisode)) {
    return bySeasonEpisode.map(v => v.videoFile);
  }
  const byTitle = parsedVideos.filter(video => video.title && video.title === parsedSub.title);
  if (singleVideoFile(byTitle)) {
    return byTitle.map(v => v.videoFile);
  }
  const byEpisode = parsedVideos.filter(video => JSON.stringify(video.episodes) === JSON.stringify(parsedSub.episodes));
  if (singleVideoFile(byEpisode)) {
    return byEpisode.map(v => v.videoFile);
  }
  return undefined;
}

function singleVideoFile(videos) {
  return new Set(videos.map(v => v.videoFile.fileIndex)).size === 1;
}

module.exports = { assignSubtitles }