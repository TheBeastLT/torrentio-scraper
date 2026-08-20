import OffcloudClient from 'offcloud-api';
import magnet from 'magnet-uri';
import { Type } from '../lib/types.js';
import { isVideo } from '../lib/extension.js';
import StaticResponse from './static.js';
import { getMagnetLink } from '../lib/magnetHelper.js';
import { sameFilename, streamFilename, BadTokenError, AccessDeniedError, NotFoundError } from './mochHelper.js';

const KEY = 'offcloud';

export async function getCachedStreams(streams, apiKey) {
  const options = await getDefaultOptions();
  const OC = new OffcloudClient(apiKey, options);
  const magnets = streams.map(stream => magnet.encode({ infoHash: stream.infoHash }));
  const available = await OC.cache.info(magnets)
      .catch(error => {
        if (toCommonError(error)) {
          return Promise.reject(error);
        }
        console.warn('Failed Offcloud cached torrent availability request:', error);
        return undefined;
      });
  return available && streams
      .reduce((mochStreams, stream, index) => {
        const fileName = streamFilename(stream);
        mochStreams[`${stream.infoHash}@${stream.fileIdx}`] = {
          url: `${apiKey}/${stream.infoHash}/${fileName}/${stream.fileIdx}`,
          cached: available[index]?.cached || false
        };
        return mochStreams;
      }, {})
}

export async function getCatalog(apiKey, catalogId, config) {
  if (config.skip > 0) {
    return [];
  }
  const options = await getDefaultOptions();
  const OC = new OffcloudClient(apiKey, options);
  return OC.cloud.history()
      .then(torrents => (torrents || [])
          .filter(torrent => statusReady(torrent))
          .map(torrent => ({
            id: `${KEY}:${torrent.requestId}`,
            type: Type.OTHER,
            name: torrent.fileName
          })));
}

export async function getItemMeta(itemId, apiKey, ip) {
  const options = await getDefaultOptions(ip);
  const OC = new OffcloudClient(apiKey, options);
  const files = await OC.cloud.explore(itemId)
      .then(response => response?.files?.length ? response.files : Promise.reject(NotFoundError));
  return {
    id: `${KEY}:${itemId}`,
    type: Type.OTHER,
    name: files[0].path.split('/')[0],
    videos: files
        .filter(file => isVideo(file.path))
        .map((file, index) => ({
          id: `${KEY}:${itemId}:${index}`,
          title: file.path,
          released: new Date(Date.now() - index).toISOString(),
          streams: [{ url: file.url }]
        }))
  };
}

export async function resolve({ ip, apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  console.log(`Unrestricting Offcloud ${infoHash} [${fileIndex}]`);
  const options = await getDefaultOptions(ip);
  const OC = new OffcloudClient(apiKey, options);
  const magnetLink = await getMagnetLink(infoHash);
  return _getCachedLink(OC, magnetLink, infoHash, cachedEntryInfo, fileIndex)
      .then(link => link ?? _resolve(OC, magnetLink, infoHash, cachedEntryInfo, fileIndex))
      .catch(error => {
        if (isAccessDeniedError(error) || isBadTokenError(error)) {
          console.log(`Access denied to Offcloud ${infoHash} [${fileIndex}]`);
          return StaticResponse.FAILED_ACCESS;
        }
        return Promise.reject(`Failed Offcloud adding torrent ${JSON.stringify(error?.message || error)}`);
      });
}

async function _getCachedLink(OC, magnetLink, infoHash, encodedFileName, fileIndex) {
  const files = await OC.cache.download(magnetLink)
      .catch(error => isFailedDownloadError(error) ? undefined : Promise.reject(error));
  if (files?.length) {
    const targetFileName = decodeURIComponent(encodedFileName);
    const videos = files.filter(file => isVideo(file.filename)).sort((a, b) => b.size - a.size);
    const targetVideo = Number.isInteger(fileIndex)
        && videos.find(video => sameFilename([...(video.folder || []), video.filename].join('/'), targetFileName))
        || videos[0];
    if (targetVideo) {
      console.log(`Unrestricted Offcloud ${infoHash} [${fileIndex}] to ${targetVideo.url}`);
      return targetVideo.url;
    }
  }
  return undefined;
}

async function _resolve(OC, magnetLink, infoHash, cachedEntryInfo, fileIndex) {
  const download = await OC.cloud.download(magnetLink);
  if (statusReady(download)) {
    return _getCachedLink(OC, magnetLink, infoHash, cachedEntryInfo, fileIndex)
        .then(link => link ?? Promise.reject(`Failed Offcloud adding torrent ${JSON.stringify(download)}`));
  } else if (statusDownloading(download)) {
    console.log(`Downloading to Offcloud ${infoHash} [${fileIndex}]...`);
    return StaticResponse.DOWNLOADING;
  } else if (statusError(download)) {
    console.log(`Failed download in Offcloud ${infoHash} [${fileIndex}]`);
    return StaticResponse.FAILED_DOWNLOAD;
  }
  return Promise.reject(`Failed Offcloud adding torrent ${JSON.stringify(download)}`);
}

async function getDefaultOptions(ip) {
  return { ip, timeout: 10000 };
}

export function toCommonError(error) {
  if (isBadTokenError(error)) {
    return BadTokenError;
  }
  if (isAccessDeniedError(error)) {
    return AccessDeniedError;
  }
  return undefined;
}

function statusDownloading(torrent) {
  return ['created', 'downloading', 'queued'].includes(torrent?.status);
}

function statusError(torrent) {
  return ['error', 'canceled'].includes(torrent?.status);
}

function statusReady(torrent) {
  return torrent?.status === 'downloaded';
}

function isBadTokenError(error) {
  const message = `${error?.message || error}`;
  return ['NOAUTH', 'Unauthorized'].some(value => message.includes(value));
}

function isAccessDeniedError(error) {
  return `${error?.message || error}`.includes('not premium');
}

function isSingleFileError(error) {
  return `${error?.message || error}`.includes('Bad archive');
}

function isFailedDownloadError(error) {
  return `${error?.message || error}`.includes('Unsupported link for direct download');
}

