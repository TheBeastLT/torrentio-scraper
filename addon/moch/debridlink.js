import DebridLinkClient from 'debrid-link-api';
import { Type } from '../lib/types.js';
import { isVideo, isArchive } from '../lib/extension.js';
import StaticResponse from './static.js';
import { getMagnetLink } from '../lib/magnetHelper.js';
import { BadTokenError } from './mochHelper.js';

const KEY = 'debridlink';

export async function getCachedStreams(streams, apiKey) {
  return streams
      .reduce((mochStreams, stream) => {
        mochStreams[`${stream.infoHash}@${stream.fileIdx}`] = {
          url: `${apiKey}/${stream.infoHash}/null/${stream.fileIdx}`,
          cached: false
        };
        return mochStreams;
      }, {})
}

export async function getCatalog(apiKey, offset = 0) {
  if (offset > 0) {
    return [];
  }
  const options = await getDefaultOptions();
  const DL = new DebridLinkClient(apiKey, options);
  return DL.seedbox.list()
      .then(response => response.value)
      .then(torrents => (torrents || [])
          .filter(torrent => torrent && statusReady(torrent))
          .map(torrent => ({
            id: `${KEY}:${torrent.id}`,
            type: Type.OTHER,
            name: torrent.name
          })));
}

export async function getItemMeta(itemId, apiKey, ip) {
  const options = await getDefaultOptions(ip);
  const DL = new DebridLinkClient(apiKey, options);
  return DL.seedbox.list(itemId)
      .then(response => response.value[0])
      .then(torrent => ({
        id: `${KEY}:${torrent.id}`,
        type: Type.OTHER,
        name: torrent.name,
        infoHash: torrent.hashString.toLowerCase(),
        videos: torrent.files
            .filter(file => isVideo(file.name))
            .map((file, index) => ({
              id: `${KEY}:${torrent.id}:${index}`,
              title: file.name,
              released: new Date(torrent.created * 1000 - index).toISOString(),
              streams: [{ url: file.downloadUrl }]
            }))
      }))
}

export async function resolve({ ip, apiKey, infoHash, fileIndex }) {
  console.log(`Unrestricting DebridLink ${infoHash} [${fileIndex}]`);
  const options = await getDefaultOptions(ip);
  const DL = new DebridLinkClient(apiKey, options);

  return _resolve(DL, infoHash, fileIndex)
      .catch(error => {
        if (errorExpiredSubscriptionError(error)) {
          console.log(`Access denied to DebridLink ${infoHash} [${fileIndex}]`);
          return StaticResponse.FAILED_ACCESS;
        }
        return Promise.reject(`Failed DebridLink adding torrent ${JSON.stringify(error)}`);
      });
}

async function _resolve(DL, infoHash, fileIndex) {
  const torrent = await _createOrFindTorrent(DL, infoHash);
  if (torrent && statusReady(torrent)) {
    return _unrestrictLink(DL, torrent, fileIndex);
  } else if (torrent && statusDownloading(torrent)) {
    console.log(`Downloading to DebridLink ${infoHash} [${fileIndex}]...`);
    return StaticResponse.DOWNLOADING;
  }

  return Promise.reject(`Failed DebridLink adding torrent ${JSON.stringify(torrent)}`);
}

async function _createOrFindTorrent(DL, infoHash) {
  return _findTorrent(DL, infoHash)
      .catch(() => _createTorrent(DL, infoHash));
}

async function _findTorrent(DL, infoHash) {
  const torrents = await DL.seedbox.list().then(response => response.value);
  const foundTorrents = torrents.filter(torrent => torrent.hashString.toLowerCase() === infoHash);
  return foundTorrents[0] || Promise.reject('No recent torrent found');
}

async function _createTorrent(DL, infoHash) {
  const magnetLink = await getMagnetLink(infoHash);
  const uploadResponse = await DL.seedbox.add(magnetLink, null, true);
  return uploadResponse.value;
}

async function _unrestrictLink(DL, torrent, fileIndex) {
  const targetFile = Number.isInteger(fileIndex)
      ? torrent.files[fileIndex]
      : torrent.files.filter(file => file.downloadPercent === 100).sort((a, b) => b.size - a.size)[0];

  if (!targetFile && torrent.files.every(file => isArchive(file.downloadUrl))) {
    console.log(`Only DebridLink archive is available for [${torrent.hashString}] ${fileIndex}`)
    return StaticResponse.FAILED_RAR;
  }
  if (!targetFile || !targetFile.downloadUrl) {
    return Promise.reject(`No DebridLink links found for index ${fileIndex} in: ${JSON.stringify(torrent)}`);
  }
  console.log(`Unrestricted DebridLink ${torrent.hashString} [${fileIndex}] to ${targetFile.downloadUrl}`);
  return targetFile.downloadUrl;
}

async function getDefaultOptions(ip) {
  return { ip, timeout: 10000 };
}

export function toCommonError(error) {
  if (error === 'badToken') {
    return BadTokenError;
  }
  return undefined;
}

function statusDownloading(torrent) {
  return torrent.downloadPercent < 100
}

function statusReady(torrent) {
  return torrent.downloadPercent === 100;
}

function errorExpiredSubscriptionError(error) {
  return ['freeServerOverload', 'maxTorrent', 'maxLink', 'maxLinkHost', 'maxData', 'maxDataHost'].includes(error);
}
