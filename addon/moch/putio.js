const PutioAPI = require('@putdotio/api-client').default
const { encode } = require('magnet-uri');
const { isVideo } = require('../lib/extension');
const delay = require('./delay');
const StaticResponse = require('./static');

async function getCachedStreams(streams, apiKey) {
  return streams
      .reduce((mochStreams, stream) => {
        const streamTitleParts = stream.title.replace(/\n👤.*/s, '').split('\n');
        const fileName = streamTitleParts[streamTitleParts.length - 1];
        const fileIndex = streamTitleParts.length === 2 ? stream.fileIdx : null;
        const encodedFileName = encodeURIComponent(fileName);
        mochStreams[stream.infoHash] = {
          url: `${apiKey}/${stream.infoHash}/${encodedFileName}/${fileIndex}`,
          cached: false
        };
        return mochStreams;
      }, {});
}

async function resolve({ ip, apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  console.log(`Unrestricting Putio ${infoHash} [${fileIndex}]`);
  const clientId = apiKey.replace(/@.*/, '');
  const token = apiKey.replace(/.*@/, '');
  const Putio = new PutioAPI({ clientID: clientId });
  Putio.setToken(token);

  const torrent = await _createOrFindTorrent(Putio, infoHash);
  if (torrent && statusReady(torrent.status)) {
    return _unrestrictLink(Putio, torrent, cachedEntryInfo, fileIndex);
  } else if (torrent && statusDownloading(torrent.status)) {
    console.log(`Downloading to Putio ${infoHash} [${fileIndex}]...`);
    return StaticResponse.DOWNLOADING;
  } else if (torrent && statusError(torrent.status)) {
    console.log(`Retrying downloading to Putio ${infoHash} [${fileIndex}]...`);
    return _retryCreateTorrent(Putio, infoHash, cachedEntryInfo, fileIndex);
  }
  return Promise.reject("Failed Putio adding torrent");
}

async function _createOrFindTorrent(Putio, infoHash) {
  return _findTorrent(Putio, infoHash)
      .catch(() => _createTorrent(Putio, infoHash))
      .catch(error => {
        console.warn('Failed Putio torrent retrieval', error);
        return error;
      });
}

async function _retryCreateTorrent(Putio, infoHash, encodedFileName, fileIndex) {
  const newTorrent = await _createTorrent(Putio, infoHash);
  return newTorrent && statusReady(newTorrent.status)
      ? _unrestrictLink(Putio, newTorrent, encodedFileName, fileIndex)
      : StaticResponse.FAILED_DOWNLOAD;
}

async function _findTorrent(Putio, infoHash) {
  const torrents = await Putio.Transfers.Query().then(response => response.data.transfers);
  const foundTorrents = torrents.filter(torrent => torrent.source.toLowerCase().includes(infoHash));
  const nonFailedTorrent = foundTorrents.find(torrent => !statusError(torrent.status));
  const foundTorrent = nonFailedTorrent || foundTorrents[0];
  return foundTorrent || Promise.reject('No recent torrent found in Putio');
}

async function _createTorrent(Putio, infoHash) {
  const magnetLink = encode({ infoHash });
  // Add the torrent and then delay for 3 secs for putio to process it and then check it's status.
  return Putio.Transfers.Add({ url: magnetLink })
      .then(response => _getNewTorrent(Putio, response.data.transfer.id));
}

async function _getNewTorrent(Putio, torrentId, pollCounter = 0, pollRate = 2000, maxPollNumber = 15) {
  return Putio.Transfers.Get(torrentId)
      .then(response => response.data.transfer)
      .then(torrent => statusProcessing(torrent.status) && pollCounter < maxPollNumber
          ? delay(pollRate).then(() => _getNewTorrent(Putio, torrentId, pollCounter + 1))
          : torrent);
}

async function _unrestrictLink(Putio, torrent, encodedFileName, fileIndex) {
  const targetVideo = await _getTargetFile(Putio, torrent, encodedFileName, fileIndex);
  const publicToken = await _getPublicToken(Putio, targetVideo.id);
  const publicFile = await Putio.File.Public(publicToken).then(response => response.data.parent);

  if (!publicFile.stream_url || !publicFile.stream_url.length) {
    return Promise.reject(`No Putio links found for [${torrent.hash}] ${encodedFileName}`);
  }
  console.log(`Unrestricted Putio ${torrent.hash} [${fileIndex}] to ${publicFile.stream_url}`);
  return publicFile.stream_url;
}

async function _getTargetFile(Putio, torrent, encodedFileName, fileIndex) {
  const targetFileName = decodeURIComponent(encodedFileName);
  let targetFile;
  let files = await _getFiles(Putio, torrent.file_id);
  let videos = [];

  while (!targetFile && files.length) {
    const folders = files.filter(file => file.file_type === 'FOLDER');
    videos = videos.concat(files.filter(file => isVideo(file.name)));
    // when specific file index is defined search by filename
    // when it's not defined find all videos and take the largest one
    targetFile = Number.isInteger(fileIndex)
        ? videos.find(video => targetFileName.includes(video.name))
        : !folders.length && videos.sort((a, b) => b.size - a.size)[0];
    files = !targetFile
        ? await Promise.all(folders.map(folder => _getFiles(Putio, folder.id)))
            .then(results => results.reduce((a, b) => a.concat(b), []))
        : [];
  }
  return targetFile ? targetFile : Promise.reject(`No target file found for Putio [${torrent.hash}] ${targetFileName}`);
}

async function _getFiles(Putio, fileId) {
  const response = await Putio.Files.Query(fileId)
      .catch(error => Promise.reject({ ...error.data, path: error.request.path }));
  return response.data.files.length
      ? response.data.files
      : [response.data.parent];
}

async function _getPublicToken(Putio, targetVideoId) {
  const publicLinks = await Putio.Files.PublicShares().then(response => response.data.links);
  const alreadySharedLink = publicLinks.find(link => link.user_file.id === targetVideoId);
  if (alreadySharedLink) {
    return alreadySharedLink.token;
  }
  if (publicLinks.length >= 10) {
    // maximum public shares reached, revoke last one;
    await Putio.File.RevokePublicLink(publicLinks[0].id);
  }
  return Putio.File.CreatePublicLink(targetVideoId).then(response => response.data.token);
}

function statusError(status) {
  return ['ERROR'].includes(status);
}

function statusDownloading(status) {
  return ['WAITING', 'IN_QUEUE', 'DOWNLOADING'].includes(status);
}

function statusProcessing(status) {
  return ['WAITING', 'IN_QUEUE', 'COMPLETING'].includes(status);
}

function statusReady(status) {
  return ['COMPLETED', 'SEEDING'].includes(status);
}

module.exports = { getCachedStreams, resolve };