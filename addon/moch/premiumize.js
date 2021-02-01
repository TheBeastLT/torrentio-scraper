const PremiumizeClient = require('premiumize-api');
const magnet = require('magnet-uri');
const { Type } = require('../lib/types');
const { isVideo } = require('../lib/extension');
const StaticResponse = require('./static');
const { getRandomUserAgent } = require('../lib/requestHelper');
const { cacheUserAgent } = require('../lib/cache');
const { getMagnetLink } = require('../lib/magnetHelper');

const KEY = 'premiumize';

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

async function getCatalog(apiKey, offset = 0) {
  if (offset > 0) {
    return [];
  }
  const options = await getDefaultOptions(apiKey);
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

async function getItemMeta(itemId, apiKey, ip) {
  const options = await getDefaultOptions(apiKey);
  const PM = new PremiumizeClient(apiKey, options);
  const rootFolder = await PM.folder.list(itemId, null);
  return getFolderContents(PM, itemId, ip)
      .then(contents => ({
        id: `${KEY}:${itemId}`,
        type: Type.OTHER,
        name: rootFolder.name,
        videos: contents
            .map((file, index) => ({
              id: `${KEY}:${file.id}:${index}`,
              title: file.name,
              released: new Date(file.created_at * 1000 - index).toISOString(),
              streams: [
                { url: file.stream_link || file.link }
              ]
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

async function resolve({ ip, apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  console.log(`Unrestricting Premiumize ${infoHash} [${fileIndex}] for IP ${ip}`);
  const options = await getDefaultOptions(apiKey);
  const PM = new PremiumizeClient(apiKey, options);

  const cachedLink = await _getCachedLink(PM, infoHash, cachedEntryInfo, fileIndex, ip).catch(() => undefined);
  if (cachedLink) {
    return cachedLink;
  }

  return _resolve(PM, infoHash, cachedEntryInfo, fileIndex, ip)
      .catch(error => {
        if (error && error.message && error.message.includes('purchase')) {
          console.log(`Access denied to Premiumize ${infoHash} [${fileIndex}]`);
          return StaticResponse.FAILED_ACCESS;
        }
        return Promise.reject(`Failed Premiumize adding torrent ${JSON.stringify(error)}`);
      });
}

async function _resolve(PM, infoHash, cachedEntryInfo, fileIndex, ip) {
  const torrent = await _createOrFindTorrent(PM, infoHash);
  if (torrent && statusReady(torrent.status)) {
    return _getCachedLink(PM, infoHash, cachedEntryInfo, fileIndex, ip);
  } else if (torrent && statusDownloading(torrent.status)) {
    return StaticResponse.DOWNLOADING;
  } else if (torrent && statusError(torrent.status)) {
    return _retryCreateTorrent(PM, infoHash, cachedEntryInfo, fileIndex);
  }
  return Promise.reject("Failed Premiumize adding torrent");
}

async function _getCachedLink(PM, infoHash, encodedFileName, fileIndex, ip) {
  const cachedTorrent = await PM.transfer.directDownload(magnet.encode({ infoHash }), ip);
  if (cachedTorrent && cachedTorrent.content && cachedTorrent.content.length) {
    const targetFileName = decodeURIComponent(encodedFileName);
    const videos = cachedTorrent.content.filter(file => isVideo(file.path));
    const targetVideo = Number.isInteger(fileIndex)
        ? videos.find(video => video.path.includes(targetFileName))
        : videos.sort((a, b) => b.size - a.size)[0];
    const unrestrictedLink = targetVideo.stream_link || targetVideo.link;
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

function statusError(status) {
  return ['deleted', 'error', 'timeout'].includes(status);
}

function statusDownloading(status) {
  return ['waiting', 'queued', 'running'].includes(status);
}

function statusReady(status) {
  return ['finished', 'seeding'].includes(status);
}

async function getDefaultOptions(id) {
  const userAgent = await cacheUserAgent(id, () => getRandomUserAgent()).catch(() => getRandomUserAgent());

  return { timeout: 30000, headers: { 'User-Agent': userAgent } };
}

module.exports = { getCachedStreams, resolve, getCatalog, getItemMeta };