const { encode } = require('magnet-uri');
const RealDebridClient = require('real-debrid-api');
const namedQueue = require('named-queue');
const { cacheWrapResolvedUrl, cacheWrapProxy, cacheUserAgent } = require('../lib/cache');
const { getRandomProxy, getRandomUserAgent } = require('../lib/request_helper');

const unrestrictQueue = new namedQueue((task, callback) => task.method()
    .then(result => callback(false, result))
    .catch((error => callback(error))));

async function resolve(ip, apiKey, infoHash, cachedFileIds, fileIndex) {
  if (!apiKey || !infoHash || !cachedFileIds || !cachedFileIds.length) {
    return Promise.reject("No valid parameters passed");
  }
  const id = `${apiKey}_${infoHash}_${fileIndex}`;
  const method = () => cacheWrapResolvedUrl(id, () => _unrestrict(ip, apiKey, infoHash, cachedFileIds, fileIndex));

  return new Promise(((resolve, reject) => {
    unrestrictQueue.push({ id, method }, (error, result) => result ? resolve(result) : reject(error));
  }));
}

async function _unrestrict(ip, apiKey, infoHash, cachedFileIds, fileIndex) {
  console.log(`Unrestricting ${infoHash} [${fileIndex}]`);
  const options = await getDefaultOptions(ip);
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

async function getDefaultOptions(ip) {
  const userAgent = await cacheUserAgent(ip, () => getRandomUserAgent()).catch(() => getRandomUserAgent());
  const proxy = await cacheWrapProxy('realdebrid', () => getRandomProxy()).catch(() => getRandomProxy());

  return {
    proxy: proxy,
    headers: {
      'User-Agent': userAgent
    }
  };
}

module.exports = { resolve };