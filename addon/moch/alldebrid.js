const AllDebridClient = require('all-debrid-api');
const namedQueue = require('named-queue');
const isVideo = require('../lib/video');
const { getRandomProxy, getRandomUserAgent } = require('../lib/request_helper');
const { cacheWrapResolvedUrl, cacheWrapProxy, cacheUserAgent } = require('../lib/cache');

const unrestrictQueue = new namedQueue((task, callback) => task.method()
    .then(result => callback(false, result))
    .catch((error => callback(error))));

async function getCachedStreams(streams, apiKey) {
  const options = await getDefaultOptions(apiKey);
  const AD = new AllDebridClient(apiKey, options);
  const hashes = streams.map(stream => stream.infoHash);
  const available = await AD.magnet.instant(hashes)
      .catch(error => {
        console.warn('Failed AllDebrid cached torrent availability request: ', error);
        return undefined;
      });
  return available && available.data && streams
      .reduce((mochStreams, stream) => {
        const cachedEntry = available.data.magnets.find(magnet => stream.infoHash === magnet.hash.toLowerCase());
        const streamTitleParts = stream.title.replace(/\n👤.*/s, '').split('\n');
        const fileName = streamTitleParts[streamTitleParts.length - 1];
        const fileIndex = streamTitleParts.length === 2 ? stream.fileIdx : null;
        const encodedFileName = encodeURIComponent(fileName);
        mochStreams[stream.infoHash] = {
          url: `${apiKey}/${stream.infoHash}/${encodedFileName}/${fileIndex}`,
          cached: cachedEntry && cachedEntry.instant
        }
        return mochStreams;
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
  const AD = new AllDebridClient(apiKey, options);
  const cachedTorrent = await _createOrFindTorrent(AD, infoHash);
  if (cachedTorrent && cachedTorrent.status === 'Ready') {
    const targetFileName = decodeURIComponent(encodedFileName);
    const videos = cachedTorrent.links.filter(link => isVideo(link.filename));
    const targetVideo = Number.isInteger(fileIndex)
        ? videos.find(video => targetFileName.includes(video.filename))
        : videos.sort((a, b) => b.size - a.size)[0];
    const unrestrictedLink = await _unrestrictLink(AD, targetVideo.link);
    console.log(`Unrestricted ${infoHash} [${fileIndex}] to ${unrestrictedLink}`);
    return unrestrictedLink;
  }
  return Promise.reject("Failed AllDebrid adding torrent");
}

async function _createOrFindTorrent(AD, infoHash) {
  return AD.magnet.status()
      .then(response => response.data.magnets)
      .then(torrents => torrents.find(torrent => torrent.hash === infoHash))
      .then(torrent => torrent || Promise.reject('No recent torrent found'))
      .catch(() => AD.magnet.upload(infoHash)
          .then(response => AD.magnet.status(response.data.magnets[0].id)
              .then(statusResponse => statusResponse.data.magnets)))
      .catch(error => {
        console.warn('Failed AllDebrid torrent retrieval', error);
        return undefined;
      });
}

async function _unrestrictLink(AD, link) {
  if (!link || !link.length) {
    return Promise.reject("No available links found");
  }
  return AD.link.unlock(link).then(response => response.data.link);
}

async function getDefaultOptions(id, ip) {
  const userAgent = await cacheUserAgent(id, () => getRandomUserAgent()).catch(() => getRandomUserAgent());
  const proxy = await cacheWrapProxy('moch', () => getRandomProxy()).catch(() => getRandomProxy());

  return { proxy: proxy, headers: { 'User-Agent': userAgent } };
}

module.exports = { getCachedStreams, resolve };