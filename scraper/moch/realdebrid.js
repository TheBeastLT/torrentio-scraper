const { encode } = require('magnet-uri');
const RealDebridClient = require('real-debrid-api');
const namedQueue = require('named-queue');
const { cacheWrapResolvedUrl } = require('../lib/cache');

const PROXY_HOST = process.env.PROXY_HOST;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;

const unrestrictQueue = new namedQueue((task, callback) => task.method()
    .then(result => callback(false, result))
    .catch((error => callback(error))));

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

async function _unrestrict(apiKey, infoHash, cachedFileIds, fileIndex) {
  const RD = new RealDebridClient(apiKey);
  const torrentId = await _createOrFindTorrentId(RD, infoHash, cachedFileIds);
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

async function _unrestrictLink(RD, link) {
  if (!link || !link.length) {
    return Promise.reject("No available links found");
  }
  return RD._post('unrestrict/link', { form: { link }, proxy: getProxy() })
      .then(unrestrictedLink => unrestrictedLink.download);
  // .then(unrestrictedLink => RD.streaming.transcode(unrestrictedLink.id))
  // .then(transcodedLink => {
  //   const url = transcodedLink.apple && transcodedLink.apple.full
  //       || transcodedLink[Object.keys(transcodedLink)[0]].full;
  //   console.log(`Unrestricted ${link} to ${url}`);
  //   return url;
  // });
}

function getProxy() {
  if (PROXY_HOST && PROXY_USERNAME && PROXY_PASSWORD) {
    return `http://${PROXY_USERNAME}:${PROXY_PASSWORD}@${PROXY_HOST}`;
  }
  return undefined;
}

module.exports = { resolve };