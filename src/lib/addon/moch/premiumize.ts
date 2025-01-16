import PremiumizeClient from 'premiumize-api';
import magnet from 'magnet-uri';
import { Type } from '../lib/types.js';
import { isVideo, isArchive } from '../lib/extension.js';
import StaticResponse from './static.js';
import { getMagnetLink } from '../lib/magnetHelper.js';
import { BadTokenError, chunkArray, sameFilename, streamFilename } from './mochHelper.js';

const KEY = 'premiumize';

export async function getCachedStreams(streams, apiKey) {
  const options = await getDefaultOptions();
  const PM = new PremiumizeClient(apiKey, options);
  return Promise.all(chunkArray(streams, 100)
          .map(chunkedStreams => _getCachedStreams(PM, apiKey, chunkedStreams)))
      .then(results => results.reduce((all, result) => Object.assign(all, result), {}));
}

async function _getCachedStreams(PM, apiKey, streams) {
  const hashes = streams.map(stream => stream.infoHash);
  return PM.cache.check(hashes)
      .catch(error => {
        if (toCommonError(error)) {
          return Promise.reject(error);
        }
        console.warn('Failed Premiumize cached torrent availability request:', error);
        return undefined;
      })
      .then(available => streams
          .reduce((mochStreams, stream, index) => {
            const filename = streamFilename(stream);
            mochStreams[`${stream.infoHash}@${stream.fileIdx}`] = {
              url: `${apiKey}/${stream.infoHash}/${filename}/${stream.fileIdx}`,
              cached: available?.response[index]
            };
            return mochStreams;
          }, {}));
}

export async function getCatalog(apiKey, catalogId, config) {
  if (config.skip > 0) {
    return [];
  }
  const options = await getDefaultOptions();
  const PM = new PremiumizeClient(apiKey, options);
  return PM.folder.list()
      .then(response => response.content)
      .then(torrents => (torrents || [])
          .filter(torrent => torrent && torrent.type === 'folder')
          .map(torrent => ({
            id: `${KEY}:${torrent.id}`,
            type: Type.OTHER,
            name: torrent.name
          })));
}

export async function getItemMeta(itemId, apiKey, ip) {
  const options = await getDefaultOptions();
  const PM = new PremiumizeClient(apiKey, options);
  const rootFolder = await PM.folder.list(itemId, null);
  const infoHash = await _findInfoHash(PM, itemId);
  return getFolderContents(PM, itemId, ip)
      .then(contents => ({
        id: `${KEY}:${itemId}`,
        type: Type.OTHER,
        name: rootFolder.name,
        infoHash: infoHash,
        videos: contents
            .map((file, index) => ({
              id: `${KEY}:${file.id}:${index}`,
              title: file.name,
              released: new Date(file.created_at * 1000 - index).toISOString(),
              streams: [{ url: file.link || file.stream_link }]
            }))
      }))
}

async function getFolderContents(PM, itemId, ip, folderPrefix = '') {
  return PM.folder.list(itemId, null, ip)
      .then(response => response.content)
      .then(contents => Promise.all(contents
              .filter(content => content.type === 'folder')
              .map(content => getFolderContents(PM, content.id, ip, [folderPrefix, content.name].join('/'))))
          .then(otherContents => otherContents.reduce((a, b) => a.concat(b), []))
          .then(otherContents => contents
              .filter(content => content.type === 'file' && isVideo(content.name))
              .map(content => ({ ...content, name: [folderPrefix, content.name].join('/') }))
              .concat(otherContents)));
}

export async function resolve({ ip, isBrowser, apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  console.log(`Unrestricting Premiumize ${infoHash} [${fileIndex}] for IP ${ip} from browser=${isBrowser}`);
  const options = await getDefaultOptions();
  const PM = new PremiumizeClient(apiKey, options);
  return _getCachedLink(PM, infoHash, cachedEntryInfo, fileIndex, ip, isBrowser)
      .catch(() => _resolve(PM, infoHash, cachedEntryInfo, fileIndex, ip, isBrowser))
      .catch(error => {
        if (isAccessDeniedError(error)) {
          console.log(`Access denied to Premiumize ${infoHash} [${fileIndex}]`);
          return StaticResponse.FAILED_ACCESS;
        }
        if (isLimitExceededError(error)) {
          console.log(`Limits exceeded in Premiumize ${infoHash} [${fileIndex}]`);
          return StaticResponse.LIMITS_EXCEEDED;
        }
        return Promise.reject(`Failed Premiumize adding torrent ${JSON.stringify(error)}`);
      });
}

async function _resolve(PM, infoHash, cachedEntryInfo, fileIndex, ip, isBrowser) {
  const torrent = await _createOrFindTorrent(PM, infoHash);
  if (torrent && statusReady(torrent.status)) {
    return _getCachedLink(PM, infoHash, cachedEntryInfo, fileIndex, ip, isBrowser);
  } else if (torrent && statusDownloading(torrent.status)) {
    console.log(`Downloading to Premiumize ${infoHash} [${fileIndex}]...`);
    return StaticResponse.DOWNLOADING;
  } else if (torrent && statusError(torrent.status)) {
    console.log(`Retrying downloading to Premiumize ${infoHash} [${fileIndex}]...`);
    return _retryCreateTorrent(PM, infoHash, cachedEntryInfo, fileIndex);
  }
  return Promise.reject(`Failed Premiumize adding torrent ${JSON.stringify(torrent)}`);
}

async function _getCachedLink(PM, infoHash, encodedFileName, fileIndex, ip, isBrowser) {
  const cachedTorrent = await PM.transfer.directDownload(magnet.encode({ infoHash }), ip);
  if (cachedTorrent?.content?.length) {
    const targetFileName = decodeURIComponent(encodedFileName);
    const videos = cachedTorrent.content.filter(file => isVideo(file.path)).sort((a, b) => b.size - a.size);
    const targetVideo = Number.isInteger(fileIndex)
        && videos.find(video => sameFilename(video.path, targetFileName))
        || videos[0];
    if (!targetVideo && videos.every(video => isArchive(video.path))) {
      console.log(`Only Premiumize archive is available for [${infoHash}] ${fileIndex}`)
      return StaticResponse.FAILED_RAR;
    }
    const streamLink = isBrowser && targetVideo.transcode_status === 'finished' && targetVideo.stream_link;
    const unrestrictedLink = streamLink || targetVideo.link;
    console.log(`Unrestricted Premiumize ${infoHash} [${fileIndex}] to ${unrestrictedLink}`);
    return unrestrictedLink;
  }
  return Promise.reject('No cached entry found');
}

async function _createOrFindTorrent(PM, infoHash) {
  return _findTorrent(PM, infoHash)
      .catch(() => _createTorrent(PM, infoHash));
}

async function _findTorrent(PM, infoHash) {
  const torrents = await PM.transfer.list().then(response => response.transfers);
  const foundTorrents = torrents.filter(torrent => torrent.src.toLowerCase().includes(infoHash));
  const nonFailedTorrent = foundTorrents.find(torrent => !statusError(torrent.statusCode));
  const foundTorrent = nonFailedTorrent || foundTorrents[0];
  return foundTorrent || Promise.reject('No recent torrent found');
}

async function _findInfoHash(PM, itemId) {
  const torrents = await PM.transfer.list().then(response => response.transfers);
  const foundTorrent = torrents.find(torrent => `${torrent.file_id}` === itemId || `${torrent.folder_id}` === itemId);
  return foundTorrent?.src ? magnet.decode(foundTorrent.src).infoHash : undefined;
}

async function _createTorrent(PM, infoHash) {
  const magnetLink = await getMagnetLink(infoHash);
  return PM.transfer.create(magnetLink).then(() => _findTorrent(PM, infoHash));
}

async function _retryCreateTorrent(PM, infoHash, encodedFileName, fileIndex) {
  const newTorrent = await _createTorrent(PM, infoHash).then(() => _findTorrent(PM, infoHash));
  return newTorrent && statusReady(newTorrent.status)
      ? _getCachedLink(PM, infoHash, encodedFileName, fileIndex)
      : StaticResponse.FAILED_DOWNLOAD;
}

export function toCommonError(error) {
  if (error && error.message === 'Not logged in.') {
    return BadTokenError;
  }
  return undefined;
}

function statusError(status) {
  return ['deleted', 'error', 'timeout'].includes(status);
}

function statusDownloading(status) {
  return ['waiting', 'queued', 'running'].includes(status);
}

function statusReady(status) {
  return ['finished', 'seeding'].includes(status);
}

function isAccessDeniedError(error) {
  return ['Account not premium.'].some(value => error?.message?.includes(value));
}

function isLimitExceededError(error) {
  return [
      'Fair use limit reached!',
      'You already have a maximum of 25 active downloads in progress!',
      'Your space is full! Please delete old files first!'
  ].some(value => error?.message?.includes(value));
}

async function getDefaultOptions(ip) {
  return { timeout: 5000 };
}
