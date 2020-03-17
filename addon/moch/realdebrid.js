const { encode } = require('magnet-uri');
const RealDebridClient = require('real-debrid-api');
const isVideo = require('../lib/video');
const { cacheWrapUnrestricted } = require('../lib/cache');

const ADDON_HOST = process.env.ADDON_HOST || 'http://localhost:7050';
const PROXY_HOST = process.env.PROXY_HOST;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;

async function applyMoch(streams, apiKey) {
  const RD = new RealDebridClient(apiKey);
  const hashes = streams.map(stream => stream.infoHash);
  const available = await _instantAvailability(RD, hashes);
  if (available) {
    streams.forEach(stream => {
      const cachedEntry = available[stream.infoHash];
      const cachedIds = getCachedFileIds(stream.fileIdx, cachedEntry);
      if (cachedIds && cachedIds.length) {
        stream.name = `[RD Cached]\n${stream.name}`;
        stream.url = `${ADDON_HOST}/realdebrid/${apiKey}/${stream.infoHash}/${cachedIds.join(',')}/${stream.fileIdx}`;
        delete stream.infoHash;
        delete stream.fileIndex;
      }
    });
  }

  return streams;
}

async function unrestrict(apiKey, infoHash, cachedFileIds, fileIndex) {
  if (!apiKey || !infoHash || !cachedFileIds || !cachedFileIds.length) {
    return Promise.reject("No valid parameters passed");
  }
  const key = `${apiKey}_${infoHash}_${fileIndex}`;
  return cacheWrapUnrestricted(key, () => _unrestrict(apiKey, infoHash, cachedFileIds, fileIndex))
}

async function _unrestrict(apiKey, infoHash, cachedFileIds, fileIndex) {
  console.log(`Unrestricting ${infoHash} [${fileIndex}]`);
  const RD = new RealDebridClient(apiKey);
  const torrentId = await _createOrFindTorrentId(RD, infoHash, cachedFileIds);
  console.log(`Retrieved torrentId: ${torrentId}`);
  if (torrentId) {
    const info = await RD.torrents.info(torrentId);
    const targetFile = info.files.find(file => file.id === fileIndex + 1)
        || info.files.filter(file => file.selected).sort((a, b) => b.bytes - a.bytes)[0];
    const selectedFiles = info.files.filter(file => file.selected);
    const fileLink = info.links.length === 1
        ? info.links[0]
        : info.links[selectedFiles.indexOf(targetFile)];
    return _unrestrictLink(RD, fileLink);
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

async function _instantAvailability(RD, hashes) {
  return RD._get(`torrents/instantAvailability/${hashes.join('/')}`)
      .catch(error => {
        console.warn('Failed cached torrent availability request: ', error);
        return undefined;
      });
}

async function _unrestrictLink(RD, link) {
  if (!link || !link.length) {
    return Promise.reject("No available links found");
  }
  return RD._post('unrestrict/link', { form: { link }, proxy: getProxy() })
      .then(unrestrictedLink => {
        console.log(`Unrestricted ${link} to ${unrestrictedLink.download}`);
        return Promise.resolve(unrestrictedLink.download);
      });
  // .then(unrestrictedLink => RD.streaming.transcode(unrestrictedLink.id))
  // .then(transcodedLink => {
  //   const url = transcodedLink.apple && transcodedLink.apple.full
  //       || transcodedLink[Object.keys(transcodedLink)[0]].full;
  //   console.log(`Unrestricted ${link} to ${url}`);
  //   return url;
  // });
}

function getCachedFileIds(fileIndex, hosterResults) {
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

function getProxy() {
  if (PROXY_HOST && PROXY_USERNAME && PROXY_PASSWORD) {
    return `http://${PROXY_USERNAME}:${PROXY_PASSWORD}@${PROXY_HOST}`;
  }
  return undefined;
}

module.exports = { applyMoch, unrestrict };