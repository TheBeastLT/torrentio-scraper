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
    ...parseFilename(video.title)
  };
}

function _mostProbableSubtitleVideos(subtitle, parsedVideos) {
  const subTitle = (subtitle.title || subtitle.path).split('/').pop().replace(/\.(\w{2,4})$/, '');
  const parsedSub = parsePath(subtitle.title || subtitle.path);
  const byFileName = parsedVideos.filter(video => subTitle.includes(video.fileName));
  if (byFileName.length === 1) {
    return byFileName.map(v => v.videoFile);
  }
  const byTitleSeasonEpisode = parsedVideos.filter(video => video.title === parsedSub.title
      && arrayEquals(video.seasons, parsedSub.seasons)
      && arrayEquals(video.episodes, parsedSub.episodes));
  if (singleVideoFile(byTitleSeasonEpisode)) {
    return byTitleSeasonEpisode.map(v => v.videoFile);
  }
  const bySeasonEpisode = parsedVideos.filter(video => arrayEquals(video.seasons, parsedSub.seasons)
      && arrayEquals(video.episodes, parsedSub.episodes));
  if (singleVideoFile(bySeasonEpisode)) {
    return bySeasonEpisode.map(v => v.videoFile);
  }
  const byTitle = parsedVideos.filter(video => video.title && video.title === parsedSub.title);
  if (singleVideoFile(byTitle)) {
    return byTitle.map(v => v.videoFile);
  }
  const byEpisode = parsedVideos.filter(video => arrayEquals(video.episodes, parsedSub.episodes));
  if (singleVideoFile(byEpisode)) {
    return byEpisode.map(v => v.videoFile);
  }
  return undefined;
}

function singleVideoFile(videos) {
  return new Set(videos.map(v => v.videoFile.fileIndex)).size === 1;
}

function parsePath(path) {
  const pathParts = path.split('/').map(part => parseFilename(part));
  const parsedWithEpisode = pathParts.find(parsed => parsed.season && parsed.episodes);
  return parsedWithEpisode || pathParts[pathParts.length - 1];
}

function parseFilename(filename) {
  const parsedInfo = parse(filename)
  const titleEpisode = parsedInfo.title.match(/(\d+)$/);
  if (!parsedInfo.episodes && titleEpisode) {
    parsedInfo.episodes = [parseInt(titleEpisode[1], 10)];
  }
  return parsedInfo;
}

function arrayEquals(array1, array2) {
  if (!array1 || !array2) return array1 === array2;
  return array1.length === array2.length && array1.every((value, index) => value === array2[index])
}

module.exports = { assignSubtitles }