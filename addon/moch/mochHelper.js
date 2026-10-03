import * as repository  from '../lib/repository.js';

const METAHUB_URL = 'https://images.metahub.space'
export const BadTokenError = { code: 'BAD_TOKEN' }
export const AccessDeniedError = { code: 'ACCESS_DENIED' }
export const AccessBlockedError = { code: 'ACCESS_BLOCKED' }
export const NotFoundError = { code: 'NOT_FOUND' }
export const MochUnavailableError = { code: 'UNAVAILABLE' }

export function chunkArray(arr, size) {
  return arr.length > size
      ? [arr.slice(0, size), ...chunkArray(arr.slice(size), size)]
      : [arr];
}

export function streamFilename(stream) {
  const filename = stream?.behaviorHints?.filename
      || stream.title.replace(/\n👤.*/s, '').split('\n').pop().split('/').pop();
  return encodeURIComponent(filename)
}

export async function enrichMeta(itemMeta) {
  const infoHashes = [...new Set([itemMeta.infoHash]
      .concat(itemMeta.videos.map(video => video.infoHash))
      .filter(infoHash => infoHash))];
  const files = infoHashes.length ? await repository.getFiles(infoHashes).catch(() => []) : [];
  const commonImdbId = itemMeta.infoHash && mostCommonValue(files.map(file => file.imdbId));
  if (files.length) {
    return {
      ...itemMeta,
      logo: commonImdbId && `${METAHUB_URL}/logo/medium/${commonImdbId}/img`,
      poster: commonImdbId && `${METAHUB_URL}/poster/medium/${commonImdbId}/img`,
      background: commonImdbId && `${METAHUB_URL}/background/medium/${commonImdbId}/img`,
      videos: itemMeta.videos.map(video => {
        const file = files.find(file => sameFilename(video.title, file.title));
        if (file?.imdbId) {
          if (file.imdbSeason && file.imdbEpisode) {
            video.id = `${file.imdbId}:${file.imdbSeason}:${file.imdbEpisode}`;
            video.season = file.imdbSeason;
            video.episode = file.imdbEpisode;
            video.thumbnail = `https://episodes.metahub.space/${file.imdbId}/${video.season}/${video.episode}/w780.jpg`
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

export function sameFilename(filename, expectedFilename) {
  const offset = filename.length - expectedFilename.length;
  for (let i = 0; i < expectedFilename.length; i++) {
    if (filename[offset + i] !== expectedFilename[i] && expectedFilename[i] !== '�') {
      return false;
    }
  }
  return true;
}

function mostCommonValue(array) {
  const counts = new Map();
  array.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()].reduce((best, entry) => entry[1] > best[1] ? entry : best, [undefined, 0])[0];
}

const MAX_WALK_FOLDERS = 50;
const MAX_WALK_FILES = 2000;
const WALK_CONCURRENCY = 5;

export async function walkFolders(rootId, listFolder) {
  const files = [];
  const pending = [{ id: rootId, prefix: '' }];
  let listed = 0;
  while (pending.length && listed < MAX_WALK_FOLDERS && files.length < MAX_WALK_FILES) {
    const batch = pending.splice(0, Math.min(WALK_CONCURRENCY, MAX_WALK_FOLDERS - listed));
    listed += batch.length;
    const results = await Promise.all(batch.map(folder => listFolder(folder.id)));
    results.forEach(({ folders, videos }, index) => {
      const prefix = batch[index].prefix;
      videos.forEach(video => files.push({ ...video, name: [prefix, video.name].join('/') }));
      folders.forEach(folder => pending.push({ id: folder.id, prefix: [prefix, folder.name].join('/') }));
    });
  }
  return files.slice(0, MAX_WALK_FILES);
}
