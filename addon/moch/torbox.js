import axios from 'axios';
import { Type } from '../lib/types.js';
import { isVideo } from '../lib/extension.js';
import StaticResponse from './static.js';
import { getMagnetLink } from '../lib/magnetHelper.js';
import { chunkArray, BadTokenError, sameFilename, streamFilename } from './mochHelper.js';

const KEY = 'torbox';
const timeout = 30000;
const baseUrl = 'https://api.torbox.app/v1'

export async function getCachedStreams(streams, apiKey, ip) {
  const hashBatches = chunkArray(streams.map(stream => stream.infoHash), 150)
      .map(hashes => getAvailabilityResponse(apiKey, hashes));
  const available = await Promise.all(hashBatches)
      .then(results => results
          .map(data => data.map(entry => entry.hash))
          .reduce((all, result) => all.concat(result), []))
      .catch(error => {
        if (toCommonError(error)) {
          return Promise.reject(error);
        }
        const message = error.message || error;
        console.warn('Failed TorBox cached torrent availability request:', message);
        return undefined;
      });
  return available && streams
      .reduce((mochStreams, stream) => {
        const isCached = available.includes(stream.infoHash);
        const fileName = streamFilename(stream);
        mochStreams[`${stream.infoHash}@${stream.fileIdx}`] = {
          url: `${apiKey}/${stream.infoHash}/${fileName}/${stream.fileIdx}`,
          cached: isCached
        };
        return mochStreams;
      }, {})
}

export async function getCatalog(apiKey, type, config) {
  return getItemList(apiKey, type, null, config.skip)
      .then(items => (items || [])
          .filter(item => statusReady(item))
          .map(item => ({
            id: `${KEY}:${type}-${item.id}`,
            type: Type.OTHER,
            name: item.name
          })));
}

export async function getItemMeta(itemId, apiKey) {
  const [type, id] = itemId.split('-');
  const item = await getItemList(apiKey, type, id);
  const createDate = item ? new Date(item.created_at) : new Date();
  return {
    id: `${KEY}:${itemId}`,
    type: Type.OTHER,
    name: item.name,
    infoHash: item.hash,
    videos: item.files
        .filter(file => isVideo(file.short_name))
        .map((file, index) => ({
          id: `${KEY}:${itemId}:${file.id}`,
          title: file.name,
          released: new Date(createDate.getTime() - index).toISOString(),
          streams: [{ url: `${apiKey}/null/${itemId}-${file.id}/null` }]
        }))
  }
}

export async function resolve({ ip, apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  console.log(`Unrestricting TorBox ${infoHash} [${fileIndex}]`);
  return _resolve(apiKey, infoHash, cachedEntryInfo, fileIndex, ip)
      .catch(error => {
        if (isAccessDeniedError(error)) {
          console.log(`Access denied to TorBox ${infoHash} [${fileIndex}]`);
          return StaticResponse.FAILED_ACCESS;
        }
        if (isLimitExceededError(error)) {
          console.log(`Limits exceeded to TorBox ${infoHash} [${fileIndex}]`);
          return StaticResponse.LIMITS_EXCEEDED;
        }
        if (isTorrentTooBigError(error)) {
          console.log(`Torrent too big for TorBox ${infoHash} [${fileIndex}]`);
          return StaticResponse.FAILED_TOO_BIG;
        }
        return Promise.reject(`Failed TorBox adding torrent: ${JSON.stringify(error.message || error)}`);
      });
}

async function _resolve(apiKey, infoHash, cachedEntryInfo, fileIndex, ip) {
  if (infoHash === 'null') {
    const [type, rootId, fileId] = cachedEntryInfo.split('-');
    return getDownloadLink(apiKey, type, rootId, fileId, ip);
  }
  const torrent = await _createOrFindTorrent(apiKey, infoHash);
  if (torrent && statusReady(torrent)) {
    return _unrestrictLink(apiKey, infoHash, torrent, cachedEntryInfo, fileIndex, ip);
  } else if (torrent && statusDownloading(torrent)) {
    console.log(`Downloading to TorBox ${infoHash} [${fileIndex}]...`);
    return StaticResponse.DOWNLOADING;
  } else if (torrent && statusError(torrent)) {
    console.log(`Retry failed download in TorBox ${infoHash} [${fileIndex}]...`);
    return controlTorrent(apiKey, torrent.id, 'delete')
        .then(() => _retryCreateTorrent(apiKey, infoHash, cachedEntryInfo, fileIndex));
  }

  return Promise.reject(`Failed TorBox adding torrent ${JSON.stringify(torrent)}`);
}

async function _createOrFindTorrent(apiKey, infoHash) {
  return _findTorrent(apiKey, infoHash)
      .catch(() => _createTorrent(apiKey, infoHash));
}

async function _findTorrent(apiKey, infoHash) {
  const torrents = await getTorrentList(apiKey);
  const foundTorrents = torrents.filter(torrent => torrent.hash === infoHash);
  const nonFailedTorrent = foundTorrents.find(torrent => !statusError(torrent));
  const foundTorrent = nonFailedTorrent || foundTorrents[0];
  return foundTorrent || Promise.reject('No recent torrent found');
}

async function _createTorrent(apiKey, infoHash, attempts = 1) {
  const magnetLink = await getMagnetLink(infoHash);
  return createTorrent(apiKey, magnetLink)
      .then(data => {
        if (data.torrent_id) {
          return getTorrentList(apiKey, data.torrent_id);
        }
        if (data.queued_id) {
          return Promise.resolve({ ...data, download_state: 'metaDL' })
        }
        if (data?.error === 'ACTIVE_LIMIT' && attempts > 0) {
          return freeLastActiveTorrent(apiKey)
              .then(() => _createTorrent(apiKey, infoHash, attempts - 1));
        }
        return Promise.reject(`Unexpected create data: ${JSON.stringify(data)}`);
      });
}

async function _retryCreateTorrent(apiKey, infoHash, cachedEntryInfo, fileIndex) {
  const newTorrent = await _createTorrent(apiKey, infoHash);
  return newTorrent && statusReady(newTorrent)
      ? _unrestrictLink(apiKey, infoHash, newTorrent, cachedEntryInfo, fileIndex)
      : StaticResponse.FAILED_DOWNLOAD;
}

async function freeLastActiveTorrent(apiKey) {
  const torrents = await getTorrentList(apiKey);
  const seedingTorrent = torrents.filter(statusSeeding).pop();
  if (seedingTorrent) {
    return controlTorrent(apiKey, seedingTorrent.id, 'stop_seeding');
  }
  if (torrents.filter(statusDownloading).pop()) {
    return controlTorrent(apiKey, seedingTorrent.id, 'delete');
  }
  return Promise.reject({ detail: 'No torrent to pause found' });
}

async function _unrestrictLink(apiKey, infoHash, torrent, cachedEntryInfo, fileIndex, ip) {
  const targetFileName = decodeURIComponent(cachedEntryInfo);
  const videos = torrent.files
      .filter(file => isVideo(file.short_name))
      .sort((a, b) => b.size - a.size);
  const targetVideo = Number.isInteger(fileIndex)
      && videos.find(video => sameFilename(video.name, targetFileName))
      || videos[0];

  if (!targetVideo) {
    if (torrent.files.every(file => file.zipped)) {
      return StaticResponse.FAILED_RAR;
    }
    return Promise.reject(`No TorBox file found for index ${fileIndex} in: ${JSON.stringify(torrent)}`);
  }
  return getDownloadLink(apiKey, 'torrents', torrent.id, targetVideo.id, ip);
}

async function getAvailabilityResponse(apiKey, hashes) {
  const url = `${baseUrl}/api/torrents/checkcached`;
  const headers = getHeaders(apiKey);
  const params = { hash: hashes.join(','), format: 'list' };
  return axios.get(url, { params, headers, timeout })
      .then(response => {
        if (response.data?.success) {
          return Promise.resolve(response.data.data || []);
        }
        return Promise.reject(response.data);
      })
      .catch(error => Promise.reject(error.response?.data || error));
}

async function createTorrent(apiKey, magnetLink){
  const url = `${baseUrl}/api/torrents/createtorrent`
  const headers = getHeaders(apiKey);
  const data = new URLSearchParams();
  data.append('magnet', magnetLink);
  data.append('allow_zip', 'false');
  return axios.post(url, data, { headers, timeout })
      .then(response => {
        if (response.data?.success) {
          return Promise.resolve(response.data.data);
        }
        return Promise.reject(response.data);
      })
      .catch(error => Promise.reject(error.response?.data || error));
}

async function controlTorrent(apiKey, torrent_id, operation){
  const url = `${baseUrl}/api/torrents/controltorrent`
  const headers = getHeaders(apiKey);
  const data = { torrent_id, operation}
  return axios.post(url, data, { headers, timeout })
      .then(response => {
        if (response.data?.success) {
          return Promise.resolve(response.data.data);
        }
        return Promise.reject(response.data);
      })
      .catch(error => Promise.reject(error.response?.data || error));
}

async function getTorrentList(apiKey, id = undefined, offset = 0) {
  return getItemList(apiKey, 'torrents', id, offset);
}

async function getItemList(apiKey, type, id = undefined, offset = 0) {
  const url = `${baseUrl}/api/${type}/mylist`;
  const headers = getHeaders(apiKey);
  const params = { id, offset };
  return axios.get(url, { params, headers, timeout })
      .then(response => {
        if (response.data?.success) {
          if (Array.isArray(response.data.data)) {
            response.data.data.sort((a, b) => b.id - a.id);
          }
          return Promise.resolve(response.data.data);
        }
        return Promise.reject(response.data);
      })
      .catch(error => Promise.reject(error.response?.data || error));
}

async function getDownloadLink(token, type, rootId, file_id, user_ip) {
  const url = `${baseUrl}/api/${type}/requestdl`;
  const params = { token, torrent_id: rootId, usenet_id: rootId, web_id: rootId, file_id, user_ip };
  return axios.get(url, { params, timeout })
      .then(response => {
        if (response.data?.success) {
          console.log(`Unrestricted TorBox ${type} [${rootId}] to ${response.data.data}`);
          return Promise.resolve(response.data.data);
        }
        return Promise.reject(response.data);
      })
      .catch(error => Promise.reject(error.response?.data || error));
}

function getHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

export function toCommonError(data) {
  const error = data?.response?.data || data;
  if (['AUTH_ERROR', 'BAD_TOKEN'].includes(error?.error)) {
    return BadTokenError;
  }
  return undefined;
}

function statusDownloading(torrent) {
  return ['metaDL', 'downloading', 'stalled (no seeds)', 'processing', 'checking', 'completed']
      .includes(torrent?.download_state);
}

function statusError(torrent) {
  return (!torrent?.active && !torrent?.download_finished) || torrent?.download_state === 'error';
}

function statusReady(torrent) {
  return torrent?.download_present;
}

function statusSeeding(torrent) {
  return ['seeding', 'uploading (no peers)'].includes(torrent?.download_state);
}

function isAccessDeniedError(error) {
  return ['AUTH_ERROR', 'BAD_TOKEN', 'PLAN_RESTRICTED_FEATURE'].includes(error?.error);
}

function isLimitExceededError(error) {
  return ['MONTHLY_LIMIT', 'COOLDOWN_LIMIT', 'ACTIVE_LIMIT'].includes(error?.error);
}

function isTorrentTooBigError(error) {
  return ['DOWNLOAD_TOO_LARGE'].includes(error?.error);
}
