import OffcloudClient from 'offcloud-api';
import { Type } from '../lib/types.js';
import { isVideo } from '../lib/extension.js';
import StaticResponse from './static.js';
import { getMagnetLink } from '../lib/magnetHelper.js';
import { chunkArray, BadTokenError } from './mochHelper.js';

const KEY = 'offcloud';

export async function getCachedStreams(streams, apiKey) {
  const options = await getDefaultOptions();
  const OC = new OffcloudClient(apiKey, options);
  const hashBatches = chunkArray(streams.map(stream => stream.infoHash), 100);
  const available = await Promise.all(hashBatches.map(hashes => OC.instant.cache(hashes)))
      .then(results => results.map(result => result.cachedItems))
      .then(results => results.reduce((all, result) => all.concat(result), []))
      .catch(error => {
        if (toCommonError(error)) {
          return Promise.reject(error);
        }
        console.warn('Failed Offcloud cached torrent availability request:', error);
        return undefined;
      });
  return available && streams
      .reduce((mochStreams, stream) => {
        const isCached = available.includes(stream.infoHash);
        const streamTitleParts = stream.title.replace(/\n👤.*/s, '').split('\n');
        const fileName = streamTitleParts[streamTitleParts.length - 1];
        const fileIndex = streamTitleParts.length === 2 ? stream.fileIdx : null;
        const encodedFileName = encodeURIComponent(fileName);
        mochStreams[stream.infoHash] = {
          url: `${apiKey}/${stream.infoHash}/${encodedFileName}/${fileIndex}`,
          cached: isCached
        };
        return mochStreams;
      }, {})
}

export async function getCatalog(apiKey, offset = 0) {
  if (offset > 0) {
    return [];
  }
  const options = await getDefaultOptions();
  const OC = new OffcloudClient(apiKey, options);
  return OC.cloud.history()
      .then(torrents => torrents)
      .then(torrents => (torrents || [])
          .filter(torrent => torrent && statusReady(torrent))
          .map(torrent => ({
            id: `${KEY}:${torrent.requestId}`,
            type: Type.OTHER,
            name: torrent.fileName
          })));
}

export async function getItemMeta(itemId, apiKey, ip) {
  const options = await getDefaultOptions(ip);
  const OC = new OffcloudClient(apiKey, options);
  const torrents = await OC.cloud.history();
  const torrent = torrents.find(torrent => torrent.requestId === itemId)
  const createDate = torrent ? new Date(torrent.createdOn) : new Date();
  return OC.cloud.explore(itemId)
      .then(files => ({
        id: `${KEY}:${itemId}`,
        type: Type.OTHER,
        name: torrent.name,
        videos: files
            .filter(file => isVideo(file))
            .map((file, index) => ({
              id: `${KEY}:${itemId}:${index}`,
              title: file.split('/').pop(),
              released: new Date(createDate.getTime() - index).toISOString(),
              streams: [{ url: file }]
            }))
      }))
}

export async function resolve({ ip, apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  console.log(`Unrestricting Offcloud ${infoHash} [${fileIndex}]`);
  const options = await getDefaultOptions(ip);
  const OC = new OffcloudClient(apiKey, options);

  return _resolve(OC, infoHash, cachedEntryInfo, fileIndex)
      .catch(error => {
        if (errorExpiredSubscriptionError(error)) {
          console.log(`Access denied to Offcloud ${infoHash} [${fileIndex}]`);
          return StaticResponse.FAILED_ACCESS;
        }
        return Promise.reject(`Failed Offcloud adding torrent ${JSON.stringify(error)}`);
      });
}

async function _resolve(OC, infoHash, cachedEntryInfo, fileIndex) {
  const torrent = await _createOrFindTorrent(OC, infoHash);
  if (torrent && statusReady(torrent)) {
    return _unrestrictLink(OC, infoHash, torrent, cachedEntryInfo, fileIndex);
  } else if (torrent && statusDownloading(torrent)) {
    console.log(`Downloading to Offcloud ${infoHash} [${fileIndex}]...`);
    return StaticResponse.DOWNLOADING;
  }

  return Promise.reject(`Failed Offcloud adding torrent ${JSON.stringify(torrent)}`);
}

async function _createOrFindTorrent(OC, infoHash) {
  return _findTorrent(OC, infoHash)
      .catch(() => _createTorrent(OC, infoHash));
}

async function _findTorrent(OC, infoHash) {
  const torrents = await OC.cloud.history();
  const foundTorrents = torrents.filter(torrent => torrent.originalLink.toLowerCase().includes(infoHash));
  const nonFailedTorrent = foundTorrents.find(torrent => !statusError(torrent));
  const foundTorrent = nonFailedTorrent || foundTorrents[0];
  return foundTorrent || Promise.reject('No recent torrent found');
}

async function _createTorrent(OC, infoHash) {
  const magnetLink = await getMagnetLink(infoHash);
  return await OC.cloud.download(magnetLink)
}

async function _unrestrictLink(OC, infoHash, torrent, cachedEntryInfo, fileIndex) {
  const files = await OC.cloud.explore(torrent.requestId)
  const targetFile = Number.isInteger(fileIndex)
      ? files.find(file => file.includes(`/${torrent.requestId}/${fileIndex}/`))
      : files.find(file => isVideo(file));

  if (!targetFile) {
    return Promise.reject(`No Offcloud links found for index ${fileIndex} in: ${JSON.stringify(torrent)}`);
  }
  console.log(`Unrestricted Offcloud ${infoHash} [${fileIndex}] to ${targetFile}`);
  return targetFile;
}

async function getDefaultOptions(ip) {
  return { ip, timeout: 5000 };
}

export function toCommonError(error) {
  if (error?.error === 'NOAUTH' || error?.message?.startsWith('Cannot read property')) {
    return BadTokenError;
  }
  return undefined;
}

function statusDownloading(torrent) {
  return ['downloading', 'created'].includes(torrent.status);
}

function statusError(torrent) {
  return torrent.status === 'error'
}

function statusReady(torrent) {
  return torrent.status === 'downloaded';
}

function errorExpiredSubscriptionError(error) {
  return error && (error.includes('not_available') || error.includes('NOAUTH'));
}
