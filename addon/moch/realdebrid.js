const needle = require('needle');
const { encode } = require('magnet-uri');
const RealDebridClient = require('real-debrid-api');
const isVideo = require('../lib/video');
const { cacheWrapUnrestricted } = require('../lib/cache');

const ADDON_HOST = process.env.TORRENTIO_ADDON_HOST || 'http://localhost:7050';

async function applyMoch(streams, token) {
  const streamMapping = streams.reduce((map, stream) => (map[stream.infoHash] = stream, map), {});
  const hashes = streams.map(stream => stream.infoHash);
  const available = await _instantAvailability(hashes, token);
  if (available) {
    Object.entries(available)
        .filter(([key, value]) => getCachedFileIds(streamMapping[key.toLowerCase()].fileIdx, value).length)
        .map(([key]) => key.toLowerCase())
        .map(cachedInfoHash => streams.find(stream => stream.infoHash === cachedInfoHash))
        .forEach(stream => {
          stream.name = `[RD Cached]\n${stream.name}`;
          stream.url = `${ADDON_HOST}/realdebrid/${token}/${stream.infoHash}/${stream.fileIdx}`;
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
  if (!apiKey || !infoHash) {
    return Promise.reject("No valid parameters passed");
  }
  console.log(`Unrestricting ${infoHash} [${fileIndex}]`);
  const RD = new RealDebridClient(apiKey);
  const torrentId = await _createOrFindTorrentId(RD, infoHash);
  console.log(`Retrieved torrentId: ${torrentId}`);
  if (torrentId) {
    const info = await RD.torrents.info(torrentId);
    const downloadFile = info.files.find(file => file.id === fileIndex + 1);
    const selectedFiles = info.files.filter(file => file.selected);
    const fileLink = info.links.length === 1
        ? info.links[0]
        : info.links[selectedFiles.indexOf(downloadFile)];
    const unrestrictedLink = fileLink && await RD.unrestrict.link(fileLink);

    if (unrestrictedLink) {
      console.log(`Unrestricted ${infoHash} [${fileIndex}] to ${unrestrictedLink.download}`);
      return Promise.resolve(unrestrictedLink.download);
    }
    return Promise.reject("No available links found");
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

async function _instantAvailability(hashes, token) {
  const endpoint = `torrents/instantAvailability/${hashes.join('/')}`;
  return _request(endpoint, { token })
      .catch(error => {
        console.warn('Failed cached torrent availability request: ', error)
        return undefined;
      });
}

async function _request(endpoint, config) {
  const url = new RealDebridClient().base_url + endpoint;
  const method = config.method || 'get';
  const headers = { 'Authorization': 'Bearer ' + config.token };

  return needle(method, url, { headers })
      .then(response => {
        if (response.body && typeof response.body === 'object') {
          return response.body;
        }
        return Promise.reject('No response body');
      })
}

module.exports = { applyMoch, unrestrict };