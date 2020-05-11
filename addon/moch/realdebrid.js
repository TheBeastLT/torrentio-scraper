const RealDebridClient = require('real-debrid-api');
const namedQueue = require('named-queue');
const { encode } = require('magnet-uri');
const isVideo = require('../lib/video');
const StaticResponse = require('./static');
const { getRandomProxy, getRandomUserAgent } = require('../lib/request_helper');
const { cacheWrapResolvedUrl, cacheWrapProxy, cacheUserAgent } = require('../lib/cache');

const MIN_SIZE = 15728640; // 15 MB

const unrestrictQueue = new namedQueue((task, callback) => task.method()
    .then(result => callback(false, result))
    .catch((error => callback(error))));

async function getCachedStreams(streams, apiKey) {
  const options = await getDefaultOptions(apiKey);
  const RD = new RealDebridClient(apiKey, options);
  const hashes = streams.map(stream => stream.infoHash);
  const available = await RD.torrents.instantAvailability(hashes)
      .catch(error => {
        console.warn('Failed RealDebrid cached torrent availability request: ', error);
        return undefined;
      });
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

async function resolve({ apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  if (!apiKey || !infoHash || !cachedEntryInfo) {
    return Promise.reject("No valid parameters passed");
  }
  const id = `${apiKey}_${infoHash}_${fileIndex}`;
  const method = () => cacheWrapResolvedUrl(id, () => _unrestrict(apiKey, infoHash, cachedEntryInfo, fileIndex))
      .catch(error => {
        console.warn(error);
        return StaticResponse.FAILED_UNEXPECTED;
      });

  return new Promise(((resolve, reject) => {
    unrestrictQueue.push({ id, method }, (error, result) => result ? resolve(result) : reject(error));
  }));
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

async function _unrestrict(apiKey, infoHash, cachedFileIds, fileIndex) {
  console.log(`Unrestricting ${infoHash} [${fileIndex}]`);
  const options = await getDefaultOptions(apiKey);
  const RD = new RealDebridClient(apiKey, options);
  const torrentId = await _createOrFindTorrentId(RD, infoHash, cachedFileIds);
  const torrent = torrentId && await RD.torrents.info(torrentId);
  if (torrent && statusReady(torrent.status)) {
    return _unrestrictLink(RD, torrent, fileIndex);
  } else if (torrent && statusDownloading(torrent.status)) {
    return StaticResponse.DOWNLOADING;
  } else if (torrent && statusError(torrent.status)) {
    return _retryCreateTorrent(RD, infoHash, cachedFileIds, fileIndex);
  } else if (torrent && statusWaitingSelection(torrent.status)) {
    await _selectTorrentFiles(RD, torrent);
    return StaticResponse.DOWNLOADING;
  } else if (torrent && torrent.code === 9) {
    return StaticResponse.FAILED_ACCESS;
  }
  return Promise.reject("Failed RealDebrid adding torrent");
}

async function _createOrFindTorrentId(RD, infoHash, cachedFileIds) {
  return _findTorrent(RD, infoHash)
      .catch(() => _createTorrentId(RD, infoHash, cachedFileIds))
      .catch(error => {
        console.warn('Failed RealDebrid torrent retrieval', error);
        return error;
      });
}

async function _retryCreateTorrent(RD, infoHash, cachedFileIds, fileIndex) {
  const newTorrentId = await _createTorrentId(RD, infoHash, cachedFileIds);
  const newTorrent = await RD.torrents.info(newTorrentId);
  return newTorrent && statusReady(newTorrent.status)
      ? _unrestrictLink(RD, newTorrent, fileIndex)
      : StaticResponse.FAILED_DOWNLOAD;
}

async function _findTorrent(RD, infoHash) {
  const torrents = await RD.torrents.get(0, 1);
  const foundTorrents = torrents.filter(torrent => torrent.hash.toLowerCase() === infoHash);
  const nonFailedTorrent = foundTorrents.find(torrent => !statusError(torrent.status));
  const foundTorrent = nonFailedTorrent || foundTorrents[0];
  return foundTorrent && foundTorrent.id || Promise.reject('No recent torrent found');
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

  torrent = torrent.status ? torrent : await RD.torrents.info(torrent.id);
  if (torrent && statusOpening(torrent.status)) {
    // sleep for 2 seconds, maybe the torrent will be converted
    await new Promise((resolve) => setTimeout(resolve, 2000));
    torrent = await RD.torrents.info(torrent.id);
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
    await _selectTorrentFiles(RD, torrent, `${fileIndex + 1}`);
    return StaticResponse.DOWNLOADING;
  }

  const selectedFiles = torrent.files.filter(file => file.selected);
  const fileLink = torrent.links.length === 1
      ? torrent.links[0]
      : torrent.links[selectedFiles.indexOf(targetFile)];

  if (!fileLink || !fileLink.length) {
    return Promise.reject("No available links found");
  }

  const unrestrictedLink = await RD.unrestrict.link(fileLink).then(response => response.download);
  if (!isVideo(unrestrictedLink)) {
    return StaticResponse.FAILED_RAR;
  }
  // const transcodedLink = await RD.streaming.transcode(unrestrictedLink.id);
  console.log(`Unrestricted ${torrent.hash} [${fileIndex}] to ${unrestrictedLink}`);
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
  return ['downloading', 'queued'].includes(status)
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