const DebridLinkClient = require('debrid-link-api');
const { Type } = require('../lib/types');
const { isVideo, isArchive } = require('../lib/extension');
const StaticResponse = require('./static');
const { getMagnetLink } = require('../lib/magnetHelper');
const { chunkArray } = require('./mochHelper');
const delay = require('./delay');

const KEY = 'debridlink';

async function getCachedStreams(streams, apiKey) {
  const options = await getDefaultOptions();
  const DL = new DebridLinkClient(apiKey, options);
  const hashBatches = chunkArray(streams.map(stream => stream.infoHash), 50)
      .map(batch => batch.join(','));
  const available = await Promise.all(hashBatches.map(hashes => DL.seedbox.cached(hashes)))
      .then(results => results.map(result => result.value))
      .then(results => results.reduce((all, result) => Object.assign(all, result), {}))
      .catch(error => {
        console.warn('Failed DebridLink cached torrent availability request: ', error);
        return undefined;
      });
  return available && streams
      .reduce((mochStreams, stream) => {
        const cachedEntry = available[stream.infoHash];
        mochStreams[stream.infoHash] = {
          url: `${apiKey}/${stream.infoHash}/null/${stream.fileIdx}`,
          cached: !!cachedEntry
        };
        return mochStreams;
      }, {})
}

async function getCatalog(apiKey, offset = 0) {
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

async function getItemMeta(itemId, apiKey) {
  const options = await getDefaultOptions();
  const DL = new DebridLinkClient(apiKey, options);
  return DL.seedbox.list(itemId)
      .then(response => response.value[0])
      .then(torrent => ({
        id: `${KEY}:${torrent.id}`,
        type: Type.OTHER,
        name: torrent.name,
        videos: torrent.files
            .filter(file => isVideo(file.name))
            .map((file, index) => ({
              id: `${KEY}:${torrent.id}:${index}`,
              title: file.name,
              released: new Date(torrent.created * 1000 - index).toISOString(),
              stream: { url: file.downloadUrl }
            }))
      }))
}

async function resolve({ ip, apiKey, infoHash, fileIndex }) {
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
  } else if (torrent && statusOpening(torrent)) {
    console.log(`Trying to open torrent on DebridLink ${infoHash} [${fileIndex}]...`);
    return _openTorrent(DL, torrent.id)
        .then(() => {
          console.log(`Downloading to DebridLink ${infoHash} [${fileIndex}]...`);
          return StaticResponse.DOWNLOADING
        })
        .catch(error => {
          console.log(`Failed DebridLink opening torrent ${infoHash} [${fileIndex}]:`, error);
          return StaticResponse.FAILED_OPENING;
        });
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

async function _openTorrent(DL, torrentId, pollCounter = 0, pollRate = 2000, maxPollNumber = 15) {
  return DL.seedbox.list(torrentId)
      .then(response => response.value[0])
      .then(torrent => torrent && statusOpening(torrent) && pollCounter < maxPollNumber
          ? delay(pollRate).then(() => _openTorrent(DL, torrentId, pollCounter + 1))
          : statusOpening(torrent) ? Promise.reject('Failed opening torrent') : torrent);
}

async function _unrestrictLink(DL, torrent, fileIndex) {
  const targetFile = Number.isInteger(fileIndex)
      ? torrent.files[fileIndex]
      : torrent.files.filter(file => file.downloadPercent === 100).sort((a, b) => b.size - a.size)[0];

  if (!targetFile && isArchive(targetFile.downloadUrl)) {
    console.log(`Only DebridLink archive is available for [${torrent.hash}] ${fileIndex}`)
    return StaticResponse.FAILED_RAR;
  }
  if (!targetFile || !targetFile.downloadUrl) {
    return Promise.reject(`No DebridLink links found for index ${fileIndex} in: ${JSON.stringify(torrent)}`);
  }
  console.log(`Unrestricted DebridLink ${torrent.hash} [${fileIndex}] to ${targetFile.downloadUrl}`);
  return targetFile.downloadUrl;
}

async function getDefaultOptions(ip) {
  return { timeout: 30000 };
}

function statusOpening(torrent) {
  return [2].includes(torrent.status) && torrent.peersConnected === 0;
}

function statusDownloading(torrent) {
  return [2, 4].includes(torrent.status);
}

function statusReady(torrent) {
  return torrent.downloadPercent === 100;
}

function errorExpiredSubscriptionError(error) {
  return ['freeServerOverload', 'maxTorrent', 'maxLink', 'maxLinkHost', 'maxData', 'maxDataHost'].includes(error);
}

module.exports = { getCachedStreams, resolve, getCatalog, getItemMeta };