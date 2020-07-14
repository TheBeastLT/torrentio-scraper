const RealDebridClient = require('real-debrid-api');
const { encode } = require('magnet-uri');
const { isVideo, isArchive } = require('../lib/extension');
const delay = require('./delay');
const StaticResponse = require('./static');
const { getRandomProxy, getRandomUserAgent, blacklistProxy } = require('../lib/request_helper');
const { cacheWrapProxy, cacheUserAgent, uncacheProxy } = require('../lib/cache');

const MIN_SIZE = 15728640; // 15 MB

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
      .catch(error => {
        if (retries > 0 && ['ENOTFOUND', 'ETIMEDOUT'].some(v => error.message && error.message.includes(v))) {
          blacklistProxy(options.proxy);
          return uncacheProxy('moch').then(() => _getInstantAvailable(hashes, apiKey, retries - 1));
        }
        console.warn('Failed RealDebrid cached torrent availability request: ', error);
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

async function resolve({ apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  console.log(`Unrestricting RealDebrid ${infoHash} [${fileIndex}]`);
  const options = await getDefaultOptions(apiKey);
  const RD = new RealDebridClient(apiKey, options);
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
  } else if (torrent && torrent.code === 9) {
    console.log(`Access denied to RealDebrid ${infoHash} [${fileIndex}]`);
    return StaticResponse.FAILED_ACCESS;
  }
  return Promise.reject("Failed RealDebrid adding torrent");
}

async function _createOrFindTorrentId(RD, infoHash, cachedFileIds, fileIndex) {
  return _findTorrent(RD, infoHash, fileIndex)
      .catch(() => _createTorrentId(RD, infoHash, cachedFileIds))
      .catch(error => {
        console.warn('Failed RealDebrid torrent retrieval', error);
        return error;
      });
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

  torrent = torrent.status ? torrent : await _getTorrentInfo(RD, torrent.id);
  if (torrent && statusOpening(torrent.status)) {
    // sleep for 2 seconds, maybe the torrent will be converted
    torrent = await delay(2000).then(() => _getTorrentInfo(RD, torrent.id));
  }
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

  const unrestrictedLink = await RD.unrestrict.link(fileLink).then(response => response.download);
  if (isArchive(unrestrictedLink)) {
    return StaticResponse.FAILED_RAR;
  }
  // const transcodedLink = await RD.streaming.transcode(unrestrictedLink.id);
  console.log(`Unrestricted RealDebrid ${torrent.hash} [${fileIndex}] to ${unrestrictedLink}`);
  return unrestrictedLink;
}

function statusError(status) {
  return ['error', 'dead', 'magnet_error'].includes(status)
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
  return status === 'downloaded';
}

async function getDefaultOptions(id) {
  const userAgent = await cacheUserAgent(id, () => getRandomUserAgent()).catch(() => getRandomUserAgent());
  const proxy = await cacheWrapProxy('moch', () => getRandomProxy()).catch(() => getRandomProxy());

  return { proxy: proxy, headers: { 'User-Agent': userAgent } };
}

module.exports = { getCachedStreams, resolve };