const torrentStream = require('torrent-stream');
const needle = require('needle');
const parseTorrent = require('parse-torrent');
const async = require('async');
const decode = require('magnet-uri');
const isVideo = require('./video');
const { cacheTrackers } = require('./cache');

const TRACKERS_URL = 'https://ngosang.github.io/trackerslist/trackers_best.txt';
const MAX_PEER_CONNECTIONS = process.env.MAX_PEER_CONNECTIONS || 20;
const SEEDS_CHECK_TIMEOUT = process.env.SEEDS_CHECK_TIMEOUT || 10 * 1000; // 10 secs

module.exports.updateCurrentSeeders = function (torrent) {
  return new Promise(async (resolve) => {
    if (!torrent.magnetLink && !torrent.infoHash) {
      return resolve(0);
    }
    const Tracker = require("peer-search/tracker");

    const seeders = {};
    const decodedMagnetLink = torrent.magnetLink && decode(torrent.magnetLink);
    const trackers = decodedMagnetLink && decodedMagnetLink.tr || torrent.trackers || await getDefaultTrackers();
    const callback = () => resolve(Math.max(...Object.values(seeders).map(values => values[0]).concat(0)));
    setTimeout(callback, SEEDS_CHECK_TIMEOUT);

    async.each(trackers, function (tracker, ready) {
      const t = new Tracker(tracker, {}, torrent.infoHash);
      console.error = () => 0; // do nothing
      t.run();
      t.on("info", function (inf) {
        seeders[tracker] = [inf.seeders, inf.leechers];
        ready();
      });
    }, callback);
  }).then(seeders => {
    torrent.seeders = seeders;
    return torrent;
  });
};

module.exports.updateTorrentSize = function (torrent) {
  return filesAndSizeFromTorrentStream(torrent, SEEDS_CHECK_TIMEOUT)
      .then(result => {
        torrent.size = result.size;
        torrent.files = result.files;
        return torrent;
      });
};

module.exports.sizeAndFiles = torrent => filesAndSizeFromTorrentStream(torrent, 30000);

module.exports.torrentFiles = function (torrent) {
  return getFilesFromObject(torrent)
      .catch(() => filesFromTorrentFile(torrent))
      .catch(() => filesFromTorrentStream(torrent))
      .then((files) => filterVideos(files))
      .then((files) => filterSamples(files))
      .then((files) => filterExtras(files));
};

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

async function filesFromTorrentStream(torrent) {
  return filesAndSizeFromTorrentStream(torrent, 60000).then(result => result.files);
}

function filesAndSizeFromTorrentStream(torrent, timeout = 60000) {
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
  return files.filter((file) => isVideo(file.path));
}

function filterSamples(files) {
  const maxSize = Math.max(...files.map(file => file.size));
  const isSample = file => file.name.match(/sample/i) && maxSize / file.size < 10;
  return files.filter(file => !isSample(file));
}

function filterExtras(files) {
  const isExtra = file => file.path.match(/extras?\//i);
  return files.filter(file => !isExtra(file));
}

async function getDefaultTrackers() {
  return cacheTrackers(() => needle('get', TRACKERS_URL, { open_timeout: SEEDS_CHECK_TIMEOUT })
      .then(response => response.body && response.body.trim())
      .then(body => body && body.split('\n\n') || []));
}

