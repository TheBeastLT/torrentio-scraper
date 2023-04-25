const repository = require('../lib/repository')

const METAHUB_URL = 'https://images.metahub.space'
const BadTokenError = { code: 'BAD_TOKEN' }
const AccessDeniedError = { code: 'ACCESS_DENIED' }

function chunkArray(arr, size) {
  return arr.length > size
      ? [arr.slice(0, size), ...chunkArray(arr.slice(size), size)]
      : [arr];
}

function streamFilename(stream) {
  const titleParts = stream.title.replace(/\n👤.*/s, '').split('\n');
  const filePath = titleParts.pop();
  const filename = titleParts.length
      ? filePath.split('/').pop()
      : filePath;
  return encodeURIComponent(filename)
}

async function enrichMeta(itemMeta) {
  const torrent = itemMeta.infoHash && await repository.getTorrentWithFiles(itemMeta.infoHash);
  const commonImdbId = torrent && mostCommonValue(torrent.files.map(file => file.imdbId));
  if (commonImdbId) {
    return {
      ...itemMeta,
      id: commonImdbId,
      logo: `${METAHUB_URL}/logo/medium/${commonImdbId}/img`,
      poster: `${METAHUB_URL}/poster/medium/${commonImdbId}/img`,
      background: `${METAHUB_URL}/background/medium/${commonImdbId}/img`,
      videos: itemMeta.videos.map(video => {
        const file = torrent.files.find(file => video.title.includes(file.title));
        if (file && file.imdbId) {
          if (file.imdbSeason && file.imdbEpisode) {
            video.id = `${file.imdbId}:${file.imdbSeason}:${file.imdbEpisode}`;
            video.season = file.imdbSeason;
            video.episode = file.imdbEpisode;
            video.thumbnail = `https://episodes.metahub.space/${commonImdbId}/${video.season}/${video.episode}/w780.jpg`
          } else {
            video.id = file.imdbId;
            video.thumbnail = `${METAHUB_URL}/background/small/${file.imdbId}/img`;
          }
        }
        return video;
      })
    }
  }
  return itemMeta
}

function mostCommonValue(array) {
  return array.sort((a, b) => array.filter(v => v === a).length - array.filter(v => v === b).length).pop();
}

module.exports = { chunkArray, streamFilename, enrichMeta, BadTokenError, AccessDeniedError }
