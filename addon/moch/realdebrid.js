const RealDebridClient = require('real-debrid-api');
const namedQueue = require('named-queue');
const { encode } = require('magnet-uri');
const isVideo = require('../lib/video');
const { getRandomProxy, getRandomUserAgent } = require('../lib/request_helper');
const { cacheWrapResolvedUrl, cacheWrapProxy, cacheUserAgent } = require('../lib/cache');

const RESOLVER_HOST = process.env.RESOLVER_HOST || 'http://localhost:7050';

const unrestrictQueue = new namedQueue((task, callback) => task.method()
    .then(result => callback(false, result))
    .catch((error => callback(error))));

async function applyMoch(streams, apiKey) {
  const options = await getDefaultOptions(apiKey);
  const RD = new RealDebridClient(apiKey, options);
  const hashes = streams.map(stream => stream.infoHash);
  const available = await RD.torrents.instantAvailability(hashes)
      .catch(error => {
        console.warn('Failed cached torrent availability request: ', error);
        return undefined;
      });
  if (available) {
    streams.forEach(stream => {
      const cachedEntry = available[stream.infoHash];
      const cachedIds = _getCachedFileIds(stream.fileIdx, cachedEntry).join(',');
      if (cachedIds.length) {
        stream.name = `[RD+] ${stream.name}`;
        stream.url = `${RESOLVER_HOST}/realdebrid/${apiKey}/${stream.infoHash}/${cachedIds}/${stream.fileIdx}`;
        delete stream.infoHash;
        delete stream.fileIndex;
      }
    });
  }

  return streams;
}

async function resolve(apiKey, infoHash, cachedFileIds, fileIndex) {
  if (!apiKey || !infoHash || !cachedFileIds || !cachedFileIds.length) {
    return Promise.reject("No valid parameters passed");
  }
  const id = `${apiKey}_${infoHash}_${fileIndex}`;
  const method = () => cacheWrapResolvedUrl(id, () => _unrestrict(apiKey, infoHash, cachedFileIds, fileIndex));

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
  if (torrentId) {
    const info = await RD.torrents.info(torrentId);
    const targetFile = info.files.find(file => file.id === fileIndex + 1)
        || info.files.filter(file => file.selected).sort((a, b) => b.bytes - a.bytes)[0];
    const selectedFiles = info.files.filter(file => file.selected);
    const fileLink = info.links.length === 1
        ? info.links[0]
        : info.links[selectedFiles.indexOf(targetFile)];
    const unrestrictedLink = await _unrestrictLink(RD, fileLink);
    console.log(`Unrestricted ${infoHash} [${fileIndex}] to ${unrestrictedLink}`);
    return unrestrictedLink;
  }
  return Promise.reject("Failed adding torrent");
}

async function _createOrFindTorrentId(RD, infoHash, cachedFileIds) {
  return RD.torrents.get(0, 1)
      .then(torrents => torrents.find(torrent => torrent.hash.toLowerCase() === infoHash))
      .then(torrent => torrent && torrent.id || Promise.reject('No recent torrent found'))
      .catch((error) => RD.torrents.addMagnet(encode({ infoHash }))
          .then(response => RD.torrents.selectFiles(response.id, cachedFileIds)
              .then((() => response.id))))
      .catch(error => {
        console.warn('Failed RealDebrid torrent retrieval', error);
        return undefined;
      });
}

async function _unrestrictLink(RD, link) {
  if (!link || !link.length) {
    return Promise.reject("No available links found");
  }
  return RD.unrestrict.link(link)
      .then(unrestrictedLink => unrestrictedLink.download);
  // .then(unrestrictedLink => RD.streaming.transcode(unrestrictedLink.id))
  // .then(transcodedLink => {
  //   const url = transcodedLink.apple && transcodedLink.apple.full
  //       || transcodedLink[Object.keys(transcodedLink)[0]].full;
  //   console.log(`Unrestricted ${link} to ${url}`);
  //   return url;
  // });
}

async function getDefaultOptions(id) {
  const userAgent = await cacheUserAgent(id, () => getRandomUserAgent()).catch(() => getRandomUserAgent());
  const proxy = await cacheWrapProxy('realdebrid', () => getRandomProxy()).catch(() => getRandomProxy());

  return { proxy: proxy, headers: { 'User-Agent': userAgent } };
}

module.exports = { applyMoch, resolve };