import AllDebridClient from 'all-debrid-api';
import { Type } from '../lib/types.js';
import { isVideo, isArchive } from '../lib/extension.js';
import StaticResponse from './static.js';
import { getMagnetLink } from '../lib/magnetHelper.js';
import { BadTokenError, AccessDeniedError, sameFilename, streamFilename, AccessBlockedError } from './mochHelper.js';
import {
    cacheMochAvailabilityResult,
    getMochCachedAvailabilityResults,
    removeMochAvailabilityResult
} from "../lib/cache.js";

const KEY = 'alldebrid';
const AGENT = 'torrentio';

export async function getCachedStreams(streams, apiKey, ip) {
  const hashes = streams.map(stream => stream.infoHash);
  const available = await getMochCachedAvailabilityResults(KEY, hashes);
  return streams
      .reduce((mochStreams, stream) => {
        const filename = streamFilename(stream);
        mochStreams[`${stream.infoHash}@${stream.fileIdx}`] = {
          url: `${apiKey}/${stream.infoHash}/${filename}/${stream.fileIdx}`,
          cached: available[stream.infoHash]?.cached || false
        }
        return mochStreams;
      }, {})
}

export async function getCatalog(apiKey, catalogId, config) {
  if (config.skip > 0) {
    return [];
  }
  const options = await getDefaultOptions(config.ip);
  const AD = new AllDebridClient(apiKey, options);
  return AD.magnet.status()
      .then(response => response.data.magnets)
      .then(torrents => (torrents || [])
          .filter(torrent => torrent && statusReady(torrent.statusCode))
          .map(torrent => ({
            id: `${KEY}:${torrent.id}`,
            type: Type.OTHER,
            name: torrent.filename
          })));
}

export async function getItemMeta(itemId, apiKey, ip) {
  const options = await getDefaultOptions(ip);
  const AD = new AllDebridClient(apiKey, options);
  return AD.magnet.status(itemId)
      .then(response => response.data.magnets)
      .then(torrent => ({
        id: `${KEY}:${torrent.id}`,
        type: Type.OTHER,
        name: torrent.filename,
        infoHash: torrent.hash.toLowerCase(),
        videos: torrent.links
            .filter(file => isVideo(file.filename))
            .map((file, index) => ({
              id: `${KEY}:${torrent.id}:${index}`,
              title: file.filename,
              released: new Date(torrent.uploadDate * 1000 - index).toISOString(),
              streams: [{ url: `${apiKey}/${torrent.hash.toLowerCase()}/${encodeURIComponent(file.filename)}/${index}` }]
            }))
      }))
}

export async function resolve({ ip, apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  console.log(`Unrestricting AllDebrid ${infoHash} [${fileIndex}]`);
  const options = await getDefaultOptions(ip);
  const AD = new AllDebridClient(apiKey, options);

  return _resolve(AD, infoHash, cachedEntryInfo, fileIndex)
      .catch(error => {
        if (isExpiredSubscriptionError(error)) {
          console.log(`Access denied to AllDebrid ${infoHash} [${fileIndex}]`);
          return StaticResponse.FAILED_ACCESS;
        }
        if (isBlockedAccessError(error)) {
          console.log(`Access blocked to AllDebrid ${infoHash} [${fileIndex}]`);
          return StaticResponse.BLOCKED_ACCESS;
        }
        if (error.code === 'MAGNET_TOO_MANY') {
          console.log(`Deleting and retrying adding to AllDebrid ${infoHash} [${fileIndex}]...`);
          return _deleteAndRetry(AD, infoHash, cachedEntryInfo, fileIndex);
        }
        return Promise.reject(`Failed AllDebrid adding torrent ${JSON.stringify(error)}`);
      });
}

async function _resolve(AD, infoHash, cachedEntryInfo, fileIndex) {
  const torrent = await _createOrFindTorrent(AD, infoHash);
  if (statusReady(torrent?.statusCode)) {
    return _unrestrictLink(AD, torrent, cachedEntryInfo, fileIndex);
  } else if (statusDownloading(torrent?.statusCode)) {
    console.log(`Downloading to AllDebrid ${infoHash} [${fileIndex}]...`);
    removeMochAvailabilityResult(KEY, infoHash);
    return StaticResponse.DOWNLOADING;
  } else if (statusHandledError(torrent?.statusCode)) {
    console.log(`Retrying downloading to AllDebrid ${infoHash} [${fileIndex}]...`);
    return _retryCreateTorrent(AD, infoHash, cachedEntryInfo, fileIndex);
  } else if (statusTooBigEntry(torrent?.statusCode)) {
    console.log(`Torrent too big for AllDebrid ${infoHash} [${fileIndex}]`);
    return StaticResponse.FAILED_TOO_BIG;
  }

  return Promise.reject(`Failed AllDebrid adding torrent ${JSON.stringify(torrent)}`);
}

async function _createOrFindTorrent(AD, infoHash) {
  return _findTorrent(AD, infoHash)
      .catch(() => _createTorrent(AD, infoHash));
}

async function _retryCreateTorrent(AD, infoHash, encodedFileName, fileIndex) {
  const newTorrent = await _createTorrent(AD, infoHash);
  return newTorrent && statusReady(newTorrent.statusCode)
      ? _unrestrictLink(AD, newTorrent, encodedFileName, fileIndex)
      : StaticResponse.FAILED_DOWNLOAD;
}

async function _deleteAndRetry(AD, infoHash, encodedFileName, fileIndex) {
  const torrents = await AD.magnet.status().then(response => response.data.magnets);
  const lastTorrent = torrents[torrents.length - 1];
  return AD.magnet.delete(lastTorrent.id)
      .then(() => _retryCreateTorrent(AD, infoHash, encodedFileName, fileIndex));
}

async function _findTorrent(AD, infoHash) {
  const torrents = await AD.magnet.status().then(response => response.data.magnets);
  const foundTorrents = torrents.filter(torrent => torrent.hash.toLowerCase() === infoHash);
  const nonFailedTorrent = foundTorrents.find(torrent => !statusError(torrent.statusCode));
  const foundTorrent = nonFailedTorrent || foundTorrents[0];
  return foundTorrent || Promise.reject('No recent torrent found');
}

async function _createTorrent(AD, infoHash) {
  const magnetLink = await getMagnetLink(infoHash);
  const uploadResponse = await AD.magnet.upload(magnetLink);
  const torrentId = uploadResponse.data.magnets[0].id;
  if (!torrentId) {
    return Promise.reject(`No magnet added with response: ${JSON.stringify(uploadResponse)}`);
  }
  return AD.magnet.status(torrentId).then(statusResponse => statusResponse.data.magnets);
}

async function _unrestrictLink(AD, torrent, encodedFileName, fileIndex) {
  const targetFileName = decodeURIComponent(encodedFileName);
  let files = await AD.magnet.files(torrent.id)
      .then(response => response.data.magnets[0].files)
      .then(files => getNestedFiles({ e: files }))
  const videos = files.filter(link => isVideo(link.n)).sort((a, b) => b.s - a.s);
  const targetVideo = Number.isInteger(fileIndex)
      && videos.find(video => sameFilename(targetFileName, video.n))
      || videos[0];

  if (!targetVideo && videos.every(link => isArchive(link.n))) {
    console.log(`Only AllDebrid archive is available for [${torrent.hash}] ${encodedFileName}`)
    return StaticResponse.FAILED_RAR;
  }
  if (!targetVideo?.l?.length) {
    return Promise.reject(`No AllDebrid links found for [${torrent.hash}] ${encodedFileName}`);
  }
  const unrestrictedLink = await AD.link.unlock(targetVideo.l).then(response => response.data.link);
  cacheMochAvailabilityResult(KEY, torrent.hash.toLowerCase());
  console.log(`Unrestricted AllDebrid ${torrent.hash} [${fileIndex}] to ${unrestrictedLink}`);
  return unrestrictedLink;
}

function getNestedFiles(folder) {
    return folder.e.flatMap(entry => {
        if (Array.isArray(entry.e)) {
            return getNestedFiles(entry);
        }
        return [entry];
    });
}

async function getDefaultOptions(ip) {
  return { ip, base_agent: AGENT, timeout: 10000 };
}

export function toCommonError(error) {
  if (error && error.code === 'AUTH_BAD_APIKEY') {
    return BadTokenError;
  }
  if (error && error.code === 'AUTH_USER_BANNED') {
    return AccessDeniedError;
  }
  if (error && error.code === 'AUTH_BLOCKED') {
    return AccessBlockedError;
  }
  return undefined;
}

function statusError(statusCode) {
  return [5, 6, 7, 8, 9, 10, 11].includes(statusCode);
}

function statusHandledError(statusCode) {
  return [5, 7, 9, 10, 11].includes(statusCode);
}

function statusDownloading(statusCode) {
  return [0, 1, 2, 3].includes(statusCode);
}

function statusReady(statusCode) {
  return statusCode === 4;
}

function statusTooBigEntry(statusCode) {
  return statusCode === 8;
}

function isExpiredSubscriptionError(error) {
  return ['AUTH_BAD_APIKEY', 'MUST_BE_PREMIUM', 'MAGNET_MUST_BE_PREMIUM', 'FREE_TRIAL_LIMIT_REACHED', 'AUTH_USER_BANNED']
      .includes(error.code);
}

function isBlockedAccessError(error) {
  return ['AUTH_BLOCKED'].includes(error.code);
}
