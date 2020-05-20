const PremiumizeClient = require('premiumize-api');
const { encode } = require('magnet-uri');
const { isVideo } = require('../lib/extension');
const StaticResponse = require('./static');
const { getRandomProxy, getRandomUserAgent } = require('../lib/request_helper');
const { cacheWrapProxy, cacheUserAgent } = require('../lib/cache');

async function getCachedStreams(streams, apiKey) {
  const options = await getDefaultOptions(apiKey);
  const PM = new PremiumizeClient(apiKey, options);
  const hashes = streams.map(stream => stream.infoHash);
  const available = await PM.cache.check(hashes)
      .catch(error => {
        console.warn('Failed Premiumize cached torrent availability request: ', error);
        return undefined;
      });
  return available && streams
      .reduce((mochStreams, stream, index) => {
        const streamTitleParts = stream.title.replace(/\n👤.*/s, '').split('\n');
        const fileName = streamTitleParts[streamTitleParts.length - 1];
        const fileIndex = streamTitleParts.length === 2 ? stream.fileIdx : null;
        const encodedFileName = encodeURIComponent(fileName);
        mochStreams[stream.infoHash] = {
          url: `${apiKey}/${stream.infoHash}/${encodedFileName}/${fileIndex}`,
          cached: available.response[index]
        };
        return mochStreams;
      }, {})
}

async function resolve({ ip, apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  console.log(`Unrestricting ${infoHash} [${fileIndex}]`);
  const options = await getDefaultOptions(apiKey, ip);
  const PM = new PremiumizeClient(apiKey, options);

  const cachedLink = await _getCachedLink(PM, infoHash, cachedEntryInfo, fileIndex).catch(() => undefined);
  if (cachedLink) {
    return cachedLink;
  }

  const torrent = await _createOrFindTorrent(PM, infoHash, cachedEntryInfo, fileIndex);
  if (torrent && statusReady(torrent.status)) {
    return _getCachedLink(PM, infoHash, cachedEntryInfo, fileIndex);
  } else if (torrent && statusDownloading(torrent.status)) {
    return StaticResponse.DOWNLOADING;
  } else if (torrent && statusError(torrent.status)) {
    return _retryCreateTorrent(PM, infoHash, cachedEntryInfo, fileIndex);
  }
  return Promise.reject("Failed Premiumize adding torrent");
}

async function _getCachedLink(PM, infoHash, encodedFileName, fileIndex) {
  const cachedTorrent = await PM.transfer.directDownload(encode({ infoHash }));
  if (cachedTorrent && cachedTorrent.content && cachedTorrent.content.length) {
    const targetFileName = decodeURIComponent(encodedFileName);
    const videos = cachedTorrent.content.filter(file => isVideo(file.path));
    const targetVideo = Number.isInteger(fileIndex)
        ? videos.find(video => video.path.includes(targetFileName))
        : videos.sort((a, b) => b.size - a.size)[0];
    const unrestrictedLink = targetVideo.stream_link || targetVideo.link;
    console.log(`Unrestricted ${infoHash} [${fileIndex}] to ${unrestrictedLink}`);
    return unrestrictedLink;
  }
  return Promise.reject('No cached entry found');
}

async function _createOrFindTorrent(PM, infoHash) {
  return _findTorrent(PM, infoHash)
      .catch(() => _createTorrent(PM, infoHash))
      .catch(error => {
        console.warn('Failed Premiumize torrent retrieval', error);
        return error;
      });
}

async function _findTorrent(PM, infoHash) {
  const torrents = await PM.transfer.list().then(response => response.transfers);
  const foundTorrents = torrents.filter(torrent => torrent.src.toLowerCase().includes(infoHash));
  const nonFailedTorrent = foundTorrents.find(torrent => !statusError(torrent.statusCode));
  const foundTorrent = nonFailedTorrent || foundTorrents[0];
  return foundTorrent || Promise.reject('No recent torrent found');
}

async function _createTorrent(PM, infoHash) {
  return PM.transfer.create(encode({ infoHash })).then(() => _findTorrent(PM, infoHash));
}

async function _retryCreateTorrent(PM, infoHash, encodedFileName, fileIndex) {
  const newTorrent = await _createTorrent(PM, infoHash).then(() => _findTorrent(PM, infoHash));
  return newTorrent && statusReady(newTorrent.status)
      ? _getCachedLink(PM, infoHash, encodedFileName, fileIndex)
      : StaticResponse.FAILED_DOWNLOAD;
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

async function getDefaultOptions(id, ip) {
  const userAgent = await cacheUserAgent(id, () => getRandomUserAgent()).catch(() => getRandomUserAgent());
  const proxy = await cacheWrapProxy('moch', () => getRandomProxy()).catch(() => getRandomProxy());

  return { proxy: proxy, headers: { 'User-Agent': userAgent } };
}

module.exports = { getCachedStreams, resolve };