const RealDebridClient = require('real-debrid-api');
const { encode } = require('magnet-uri');
const { Type } = require('../lib/types');
const { isVideo, isArchive } = require('../lib/extension');
const delay = require('./delay');
const StaticResponse = require('./static');
const { getRandomProxy, getProxyAgent, getRandomUserAgent, blacklistProxy } = require('../lib/requestHelper');
const { cacheWrapProxy, cacheUserAgent, uncacheProxy } = require('../lib/cache');

const MIN_SIZE = 5 * 1024 * 1024; // 5 MB
const CATALOG_MAX_PAGE = 5;
const CATALOG_PAGE_SIZE = 100;
const KEY = "realdebrid"

async function getCachedStreams(streams, apiKey) {
  const hashes = streams.map(stream => stream.infoHash);
  const available = await _getInstantAvailable(hashes, apiKey);
  return available && streams
      .reduce((mochStreams, stream) => {
        const cachedEntry = available[stream.infoHash];
        const cachedIds = _getCachedFileIds(stream.fileIdx, cachedEntry);
        const cachedIdsString = cachedIds.length ? cachedIds.join(',') : null;
        mochStreams[stream.infoHash] = {
          url: `${apiKey}/${stream.infoHash}/${cachedIdsString}/${stream.fileIdx}`,
          cached: !!cachedIdsString
        };
        return mochStreams;
      }, {})
}

async function _getInstantAvailable(hashes, apiKey, retries = 3) {
  const options = await getDefaultOptions(apiKey);
  const RD = new RealDebridClient(apiKey, options);
  return RD.torrents.instantAvailability(hashes)
      .then(response => {
        if (typeof response !== 'object') {
          if (retries > 0) {
            return _getInstantAvailable(hashes, apiKey, retries - 1);
          } else {
            return Promise.reject(new Error('RD returned non JSON response: ' + response));
          }
        }
        return response;
      })
      .catch(error => {
        if (retries > 0 && ['ENOTFOUND', 'ETIMEDOUT'].some(v => error.message && error.message.includes(v))) {
          blacklistProxy(options.agent.proxy.host);
          return uncacheProxy('moch').then(() => _getInstantAvailable(hashes, apiKey, retries - 1));
        }
        if (retries > 0 && ['ESOCKETTIMEDOUT', 'EAI_AGAIN'].some(v => error.message && error.message.includes(v))) {
          return _getInstantAvailable(hashes, apiKey, retries - 1);
        }
        console.warn(`Failed RealDebrid cached [${hashes[0]}] torrent availability request: `, error.message);
        return undefined;
      });
}

function _getCachedFileIds(fileIndex, hosterResults) {
  if (!hosterResults || Array.isArray(hosterResults)) {
    return [];
  }
  // if not all cached files are videos, then the torrent will be zipped to a rar
  const cachedTorrents = Object.values(hosterResults)
      .reduce((a, b) => a.concat(b), [])
      .filter(cached => !Number.isInteger(fileIndex) && Object.keys(cached).length || cached[fileIndex + 1])
      .filter(cached => Object.values(cached).every(file => isVideo(file.filename)))
      .map(cached => Object.keys(cached))
      .sort((a, b) => b.length - a.length);
  return cachedTorrents.length && cachedTorrents[0] || [];
}

async function getCatalog(apiKey, offset = 0) {
  if (offset > 0) {
    return [];
  }
  const options = await getDefaultOptions(apiKey);
  const RD = new RealDebridClient(apiKey, options);
  return _getAllTorrents(RD)
      .then(torrents => Array.isArray(torrents) ? torrents : [])
      .then(torrents => torrents
          .filter(torrent => torrent && statusReady(torrent.status))
          .map(torrent => ({
            id: `${KEY}:${torrent.id}`,
            type: Type.OTHER,
            name: torrent.filename
          })));
}

async function _getAllTorrents(RD, page = 1) {
  return RD.torrents.get(page - 1, page, CATALOG_PAGE_SIZE)
      .then(torrents => torrents && torrents.length === CATALOG_PAGE_SIZE && page < CATALOG_MAX_PAGE
          ? _getAllTorrents(RD, page + 1)
              .then(nextTorrents => torrents.concat(nextTorrents))
              .catch(() => torrents)
          : torrents)
}

async function getItemMeta(itemId, apiKey) {
  const options = await getDefaultOptions(apiKey);
  const RD = new RealDebridClient(apiKey, options);
  return _getTorrentInfo(RD, itemId)
      .then(torrent => ({
        id: `${KEY}:${torrent.id}`,
        type: Type.OTHER,
        name: torrent.filename,
        videos: torrent.files
            .filter(file => file.selected)
            .filter(file => isVideo(file.path))
            .map((file, index) => ({
              id: `${KEY}:${torrent.id}:${file.id}`,
              title: file.path,
              released: new Date(new Date(torrent.added).getTime() + index).toISOString(),
              streams: [
                { url: `${apiKey}/${torrent.hash.toLowerCase()}/null/${file.id - 1}` }
              ]
            }))
      }))
}

async function resolve({ apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  console.log(`Unrestricting RealDebrid ${infoHash} [${fileIndex}]`);
  const options = await getDefaultOptions(apiKey);
  const RD = new RealDebridClient(apiKey, options);

  return _resolve(RD, infoHash, cachedEntryInfo, fileIndex)
      .catch(error => {
        if (accessDeniedError(error)) {
          console.log(`Access denied to RealDebrid ${infoHash} [${fileIndex}]`);
          return StaticResponse.FAILED_ACCESS;
        }
        return Promise.reject(`Failed RealDebrid adding torrent ${JSON.stringify(error)}`);
      });
}

async function _resolve(RD, infoHash, cachedEntryInfo, fileIndex) {
  const torrentId = await _createOrFindTorrentId(RD, infoHash, cachedEntryInfo, fileIndex);
  const torrent = await _getTorrentInfo(RD, torrentId);
  if (torrent && statusReady(torrent.status)) {
    return _unrestrictLink(RD, torrent, fileIndex);
  } else if (torrent && statusDownloading(torrent.status)) {
    console.log(`Downloading to RealDebrid ${infoHash} [${fileIndex}]...`);
    return StaticResponse.DOWNLOADING;
  } else if (torrent && statusError(torrent.status)) {
    console.log(`Retrying downloading to RealDebrid ${infoHash} [${fileIndex}]...`);
    return _retryCreateTorrent(RD, infoHash, cachedEntryInfo, fileIndex);
  } else if (torrent && statusWaitingSelection(torrent.status)) {
    console.log(`Trying to select files on RealDebrid ${infoHash} [${fileIndex}]...`);
    await _selectTorrentFiles(RD, torrent);
    return StaticResponse.DOWNLOADING;
  }
  return Promise.reject("Failed RealDebrid adding torrent");
}

async function _createOrFindTorrentId(RD, infoHash, cachedFileIds, fileIndex) {
  return _findTorrent(RD, infoHash, fileIndex)
      .catch(() => _createTorrentId(RD, infoHash, cachedFileIds));
}

async function _retryCreateTorrent(RD, infoHash, cachedFileIds, fileIndex) {
  const newTorrentId = await _createTorrentId(RD, infoHash, cachedFileIds);
  const newTorrent = await _getTorrentInfo(RD, newTorrentId);
  return newTorrent && statusReady(newTorrent.status)
      ? _unrestrictLink(RD, newTorrent, fileIndex)
      : StaticResponse.FAILED_DOWNLOAD;
}

async function _findTorrent(RD, infoHash, fileIndex) {
  const torrents = await RD.torrents.get(0, 1) || [];
  const foundTorrents = torrents.filter(torrent => torrent.hash.toLowerCase() === infoHash);
  const nonFailedTorrents = foundTorrents.filter(torrent => !statusError(torrent.status));
  const nonFailedTorrent = await _findBestFitTorrent(RD, nonFailedTorrents, fileIndex);
  const foundTorrent = nonFailedTorrent || foundTorrents[0];
  return foundTorrent && foundTorrent.id || Promise.reject('No recent torrent found');
}

async function _findBestFitTorrent(RD, torrents, fileIndex) {
  if (torrents.length === 1) {
    return torrents[0];
  }
  const torrentInfos = await Promise.all(torrents.map(torrent => _getTorrentInfo(RD, torrent.id)));
  const bestFitTorrents = torrentInfos
      .filter(torrent => torrent.files.find(f => f.id === fileIndex + 1 && f.selected))
      .sort((a, b) => b.links.length - a.links.length);
  return bestFitTorrents[0] || torrents[0];
}

async function _getTorrentInfo(RD, torrentId) {
  if (!torrentId || typeof torrentId === 'object') {
    return torrentId || Promise.reject('No RealDebrid torrentId provided')
  }
  return RD.torrents.info(torrentId);
}

async function _createTorrentId(RD, infoHash, cachedFileIds) {
  const addedMagnet = await RD.torrents.addMagnet(encode({ infoHash }));
  await _selectTorrentFiles(RD, { id: addedMagnet.id }, cachedFileIds);
  return addedMagnet.id;
}

async function _selectTorrentFiles(RD, torrent, cachedFileIds) {
  if (cachedFileIds && !['null', 'undefined'].includes(cachedFileIds)) {
    return RD.torrents.selectFiles(torrent.id, cachedFileIds);
  }

  torrent = statusWaitingSelection(torrent.status) ? torrent : await _openTorrent(RD, torrent.id);
  if (torrent && torrent.files && statusWaitingSelection(torrent.status)) {
    const videoFileIds = torrent.files
        .filter(file => isVideo(file.path))
        .filter(file => file.bytes > MIN_SIZE)
        .map(file => file.id)
        .join(',');
    return RD.torrents.selectFiles(torrent.id, videoFileIds);
  }
  return Promise.reject('Failed RealDebrid torrent file selection')
}

async function _openTorrent(RD, torrentId, pollCounter = 0, pollRate = 2000, maxPollNumber = 10) {
  return _getTorrentInfo(RD, torrentId)
      .then(torrent => torrent && statusOpening(torrent.status) && pollCounter < maxPollNumber
          ? delay(pollRate).then(() => _openTorrent(RD, torrentId, pollCounter + 1))
          : torrent);
}

async function _unrestrictLink(RD, torrent, fileIndex) {
  const targetFile = torrent.files.find(file => file.id === fileIndex + 1)
      || torrent.files.filter(file => file.selected).sort((a, b) => b.bytes - a.bytes)[0];
  if (!targetFile.selected) {
    await _retryCreateTorrent(RD, torrent.hash.toLowerCase(), undefined, fileIndex);
    return StaticResponse.DOWNLOADING;
  }

  const selectedFiles = torrent.files.filter(file => file.selected);
  const fileLink = torrent.links.length === 1
      ? torrent.links[0]
      : torrent.links[selectedFiles.indexOf(targetFile)];

  if (!fileLink || !fileLink.length) {
    return Promise.reject(`No RealDebrid links found for ${torrent.hash} [${fileIndex}]`);
  }

  return _unrestrictFileLink(RD, fileLink, torrent, fileIndex);
}

async function _unrestrictFileLink(RD, fileLink, torrent, fileIndex) {
  return RD.unrestrict.link(fileLink)
      .then(response => response.download)
      .then(unrestrictedLink => {
        if (isArchive(unrestrictedLink)) {
          return StaticResponse.FAILED_RAR;
        }
        // const transcodedLink = await RD.streaming.transcode(unrestrictedLink.id);
        console.log(`Unrestricted RealDebrid ${torrent.hash} [${fileIndex}] to ${unrestrictedLink}`);
        return unrestrictedLink;
      })
      .catch(error => {
        if (error.code === 19) {
          return _retryCreateTorrent(RD, torrent.hash.toLowerCase(), undefined, fileIndex)
              .then(() => StaticResponse.FAILED_DOWNLOAD);
        }
        return Promise.reject(error);
      });
}

function statusError(status) {
  return ['error', 'magnet_error'].includes(status);
}

function statusOpening(status) {
  return status === 'magnet_conversion';
}

function statusWaitingSelection(status) {
  return status === 'waiting_files_selection';
}

function statusDownloading(status) {
  return ['downloading', 'queued'].includes(status);
}

function statusReady(status) {
  return ['downloaded', 'dead'].includes(status);
}

function accessDeniedError(error) {
  return [9, 20].includes(error && error.code);
}

async function getDefaultOptions(id) {
  const userAgent = await cacheUserAgent(id, () => getRandomUserAgent()).catch(() => getRandomUserAgent());
  const proxy = await cacheWrapProxy('moch', () => getRandomProxy()).catch(() => getRandomProxy());
  const agent = getProxyAgent(proxy);

  return { timeout: 30000, agent: agent, headers: { 'User-Agent': userAgent } };
}

module.exports = { getCachedStreams, resolve, getCatalog, getItemMeta };