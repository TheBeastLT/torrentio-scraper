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
  const streamMapping = streams.reduce((map, stream) => (map[stream.infoHash] = stream, map), {});
  const available = await _instantAvailability(RD, hashes);
  if (available) {
    Object.entries(available)
        .filter(([key, value]) => getCachedFileIds(streamMapping[key.toLowerCase()].fileIdx, value).length)
        .map(([key]) => key.toLowerCase())
        .map(cachedInfoHash => streamMapping[cachedInfoHash])
        .forEach(stream => {
          stream.name = `[RD Cached]\n${stream.name}`;
          stream.url = `${ADDON_HOST}/realdebrid/${apiKey}/${stream.infoHash}/${stream.fileIdx}`;
          delete stream.infoHash;
          delete stream.fileIndex;
        })
  }

  return streams;
}

async function unrestrict(apiKey, infoHash, fileIndex) {
  if (!apiKey || !infoHash) {
    return Promise.reject("No valid parameters passed");
  }
  const key = `${apiKey}_${infoHash}_${fileIndex}`;
  return cacheWrapUnrestricted(key, () => _unrestrict(apiKey, infoHash, fileIndex))
}

async function _unrestrict(apiKey, infoHash, fileIndex) {
  console.log(`Unrestricting ${infoHash} [${fileIndex}]`);
  const RD = new RealDebridClient(apiKey);
  const torrentId = await _createOrFindTorrentId(RD, infoHash);
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

async function _createOrFindTorrentId(RD, infoHash) {
  return RD.torrents.get(0, 1)
      .then(torrents => torrents.find(torrent => torrent.hash.toLowerCase() === infoHash))
      .then(torrent => torrent && torrent.id || Promise.reject('No recent torrent found'))
      .catch((error) => RD.torrents.addMagnet(encode({ infoHash }))
          .then(response => RD.torrents.selectFiles(response.id)
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
}

function getCachedFileIds(fileIndex, hosterResults) {
  if (!hosterResults || Array.isArray(hosterResults)) {
    return [];
  }
  // if not all cached files are videos, then the torrent will be zipped to a rar
  const cachedTorrent = Object.values(hosterResults)
      .reduce((a, b) => a.concat(b), [])
      .filter(cached => isNaN(fileIndex) && Object.keys(cached).length || cached[fileIndex + 1])
      .find(cached => Object.values(cached).every(file => isVideo(file.filename)));
  return cachedTorrent && Object.keys(cachedTorrent) || [];
}

function getProxy() {
  if (PROXY_HOST && PROXY_USERNAME && PROXY_PASSWORD) {
    return `http://${PROXY_USERNAME}:${PROXY_PASSWORD}@${PROXY_HOST}`;
  }
  return undefined;
}

module.exports = { applyMoch, unrestrict };