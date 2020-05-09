const PremiumizeClient = require('premiumize-api');
const namedQueue = require('named-queue');
const { encode } = require('magnet-uri');
const isVideo = require('../lib/video');
const { getRandomProxy, getRandomUserAgent } = require('../lib/request_helper');
const { cacheWrapResolvedUrl, cacheWrapProxy, cacheUserAgent } = require('../lib/cache');

const unrestrictQueue = new namedQueue((task, callback) => task.method()
    .then(result => callback(false, result))
    .catch((error => callback(error))));

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
      .reduce((cachedStreams, stream, index) => {
        const isCached = available.response[index];
        if (isCached) {
          const streamTitleParts = stream.title.replace(/\n👤.*/s, '').split('\n');
          const fileName = streamTitleParts[streamTitleParts.length - 1];
          const fileIndex = streamTitleParts.length === 2 ? stream.fileIdx : null;
          const encodedFileName = encodeURIComponent(fileName);
          cachedStreams[stream.infoHash] = `${apiKey}/${stream.infoHash}/${encodedFileName}/${fileIndex}`;
        }
        return cachedStreams;
      }, {})
}

async function resolve({ ip, apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  if (!apiKey || !infoHash || !cachedEntryInfo) {
    return Promise.reject("No valid parameters passed");
  }
  const id = `${apiKey}_${infoHash}_${fileIndex}`;
  const method = () => cacheWrapResolvedUrl(id, () => _unrestrict(ip, apiKey, infoHash, cachedEntryInfo, fileIndex));

  return new Promise(((resolve, reject) => {
    unrestrictQueue.push({ id, method }, (error, result) => result ? resolve(result) : reject(error));
  }));
}

async function _unrestrict(ip, apiKey, infoHash, encodedFileName, fileIndex) {
  console.log(`Unrestricting ${infoHash} [${fileIndex}]`);
  const options = await getDefaultOptions(apiKey, ip);
  const PM = new PremiumizeClient(apiKey, options);
  const cachedTorrent = await PM.transfer.directDownload(encode({ infoHash }));
  if (cachedTorrent.content && cachedTorrent.content.length) {
    const targetFileName = decodeURIComponent(encodedFileName);
    const videos = cachedTorrent.content.filter(file => isVideo(file.path));
    const targetVideo = Number.isInteger(fileIndex)
        ? videos.find(video => video.path.includes(targetFileName))
        : videos.sort((a, b) => b.size - a.size)[0];
    const unrestrictedLink = targetVideo.stream_link || targetVideo.link;
    console.log(`Unrestricted ${infoHash} [${fileIndex}] to ${unrestrictedLink}`);
    return unrestrictedLink;
  }
  return Promise.reject("Failed Premiumize adding torrent");
}

async function getDefaultOptions(id, ip) {
  const userAgent = await cacheUserAgent(id, () => getRandomUserAgent()).catch(() => getRandomUserAgent());
  const proxy = await cacheWrapProxy('moch', () => getRandomProxy()).catch(() => getRandomProxy());

  return { proxy: proxy, headers: { 'User-Agent': userAgent } };
}

module.exports = { getCachedStreams, resolve };