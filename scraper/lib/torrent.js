const torrentStream = require('torrent-stream');
const needle = require('needle');
const parseTorrent = require('parse-torrent');
const BTClient = require('bittorrent-tracker')
const async = require('async');
const decode = require('magnet-uri');
const { Type } = require('./types');
const { isVideo, isSubtitle } = require('./extension');
const { cacheTrackers } = require('./cache');

const TRACKERS_URL = 'https://ngosang.github.io/trackerslist/trackers_best.txt';
const MAX_PEER_CONNECTIONS = process.env.MAX_PEER_CONNECTIONS || 20;
const SEEDS_CHECK_TIMEOUT = process.env.SEEDS_CHECK_TIMEOUT || 10 * 1000; // 10 secs
const ANIME_TRACKERS = [
  "http://nyaa.tracker.wf:7777/announce",
  "http://anidex.moe:6969/announce",
  "http://tracker.anirena.com:80/announce",
  "udp://tracker.uw0.xyz:6969/announce"
];

async function updateCurrentSeeders(torrent) {
  return new Promise(async (resolve) => {
    if (!torrent.magnetLink && !torrent.infoHash) {
      return resolve(0);
    }

    const seeders = {};
    const magnetTrackers = torrent.magnetLink && decode(torrent.magnetLink).tr;
    const torrentTrackers = torrent.trackers && torrent.trackers.split(',');
    const trackers = magnetTrackers || torrentTrackers || await getDefaultTrackers(torrent);
    const callback = () => resolve(Math.max(...Object.values(seeders).map(values => values[0]).concat(0)));
    setTimeout(callback, SEEDS_CHECK_TIMEOUT);

    async.each(trackers, function (tracker, ready) {
      BTClient.scrape({ infoHash: torrent.infoHash, announce: tracker }, (_, results) => {
        if (results) {
          seeders[tracker] = [results.complete, results.incomplete];
        }
        ready();
      })
    }, callback);
  }).then(seeders => {
    torrent.seeders = seeders;
    return torrent;
  });
}

async function updateTorrentSize(torrent) {
  return filesAndSizeFromTorrentStream(torrent, SEEDS_CHECK_TIMEOUT)
      .then(result => {
        torrent.size = result.size;
        torrent.files = result.files;
        return torrent;
      });
}

async function sizeAndFiles(torrent) {
  return filesAndSizeFromTorrentStream(torrent, 30000);
}

async function torrentFiles(torrent, timeout) {
  return getFilesFromObject(torrent)
      .catch(() => filesFromTorrentFile(torrent))
      .catch(() => filesFromTorrentStream(torrent, timeout))
      .then(files => ({
        contents: files,
        videos: filterVideos(files),
        subtitles: filterSubtitles(files)
      }));
}

function getFilesFromObject(torrent) {
  if (torrent.files && torrent.files.length) {
    return Promise.resolve(torrent.files);
  }
  return Promise.reject("No files in the object");
}

async function filesFromTorrentFile(torrent) {
  if (!torrent.torrentLink) {
    return Promise.reject(new Error("no torrentLink"));
  }

  return needle('get', torrent.torrentLink, { open_timeout: 10000 })
      .then((response) => {
        if (!response.body || response.statusCode !== 200) {
          throw new Error('torrent not found')
        }
        return response.body
      })
      .then((body) => parseTorrent(body))
      .then((info) => info.files.map((file, fileId) => ({
        fileIndex: fileId,
        name: file.name,
        path: file.path.replace(/^[^\/]+\//, ''),
        size: file.length
      })));
}

async function filesFromTorrentStream(torrent, timeout) {
  return filesAndSizeFromTorrentStream(torrent, timeout).then(result => result.files);
}

function filesAndSizeFromTorrentStream(torrent, timeout = 30000) {
  if (!torrent.infoHash && !torrent.magnetLink) {
    return Promise.reject(new Error("no infoHash or magnetLink"));
  }
  // const magnet = decode.encode({ infoHash: torrent.infoHash, announce: torrent.trackers });
  return new Promise((resolve, rejected) => {
    const engine = new torrentStream(torrent.infoHash, { connections: MAX_PEER_CONNECTIONS });

    engine.ready(() => {
      const files = engine.files
          .map((file, fileId) => ({
            fileIndex: fileId,
            name: file.name,
            path: file.path.replace(/^[^\/]+\//, ''),
            size: file.length
          }));
      const size = engine.torrent.length;

      engine.destroy();
      resolve({ files, size });
    });
    setTimeout(() => {
      engine.destroy();
      rejected(new Error('No available connections for torrent!'));
    }, timeout);
  });
}

function filterVideos(files) {
  if (files.length === 1 && !Number.isInteger(files[0].fileIndex)) {
    return files;
  }
  const videos = files.filter(file => isVideo(file.path));
  const maxSize = Math.max(...videos.map(video => video.size));
  const minSampleRatio = videos.length <= 3 ? 5 : 10;
  const minAnimeExtraRatio = 5;
  const minRedundantRatio = videos.length <= 3 ? 30 : Number.MAX_VALUE;
  const isSample = video => video.path.match(/sample/i) && maxSize / parseInt(video.size) > minSampleRatio;
  const isRedundant = video => maxSize / parseInt(video.size) > minRedundantRatio;
  const isExtra = video => video.path.match(/extras?\//i);
  const isAnimeExtra = video => video.path.match(/(?:\b|_)(?:NC)?(?:ED|OP|PV)(?:v?\d\d?)?(?:\b|_)/i)
      && maxSize / parseInt(video.size) > minAnimeExtraRatio;
  return videos
      .filter(video => !isSample(video))
      .filter(video => !isExtra(video))
      .filter(video => !isAnimeExtra(video))
      .filter(video => !isRedundant(video));
}

function filterSubtitles(files) {
  return files.filter(file => isSubtitle(file.path));
}

async function getDefaultTrackers(torrent) {
  return cacheTrackers(() => needle('get', TRACKERS_URL, { open_timeout: SEEDS_CHECK_TIMEOUT })
      .then(response => response.body && response.body.trim())
      .then(body => body && body.split('\n\n') || []))
      .then(trackers => torrent.type === Type.ANIME ? trackers.concat(ANIME_TRACKERS) : trackers);
}

module.exports = { updateCurrentSeeders, updateTorrentSize, sizeAndFiles, torrentFiles }
