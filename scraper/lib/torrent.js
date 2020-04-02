const torrentStream = require('torrent-stream');
const needle = require('needle');
const parseTorrent = require('parse-torrent');
const async = require('async');
const decode = require('magnet-uri');
const { retrieveTorrentFiles } = require('./cache');
const isVideo = require('./video');

const MAX_PEER_CONNECTIONS = process.env.MAX_PEER_CONNECTIONS || 20;
const SEEDS_CHECK_TIMEOUT = process.env.SEEDS_CHECK_TIMEOUT || 10 * 1000; // 10 secs

module.exports.updateCurrentSeeders = function (torrent) {
  return new Promise((resolve) => {
    if (!torrent.magnetLink) {
      return resolve(0);
    }
    const Tracker = require("peer-search/tracker");

    const seeders = {};
    const decodedMagnetLink = decode(torrent.magnetLink);
    const trackers = decodedMagnetLink && decodedMagnetLink.tr;
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
  }).then((seeders) => ({ ...torrent, seeders: torrent.seeders || seeders }));
};

module.exports.updateTorrentSize = function (torrent) {
  if (!torrent.infoHash && !torrent.magnetLink) {
    return Promise.reject(new Error("no infoHash or magnetLink"));
  }
  const magnetLink = torrent.magnetLink || decode.encode({ infoHash: torrent.infoHash });
  return new Promise((resolve, rejected) => {
    const engine = new torrentStream(magnetLink, { connections: MAX_PEER_CONNECTIONS });

    engine.ready(() => {
      const size = engine.torrent.length;
      engine.destroy();
      resolve({ size });
    });
    setTimeout(() => {
      engine.destroy();
      rejected(new Error('No available connections for torrent!'));
    }, SEEDS_CHECK_TIMEOUT);
  }).then((size) => ({ ...torrent, size }));
};

module.exports.sizeAndFiles = function (torrent) {
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
    }, 20000);
  });
};

module.exports.torrentFiles = function (torrent) {
  return getFilesFromObject(torrent)
      .catch(() => filesFromTorrentFile(torrent))
      .catch(() => filesFromTorrentStream(torrent))
      .catch(() => filesFromCache(torrent.infoHash))
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

function filesFromCache(infoHash) {
  return retrieveTorrentFiles(infoHash)
      .then((files) => files.map((file) => ({
        fileIndex: parseInt(file.match(/^(\d+)@@/)[1]),
        name: file.replace(/.+\/|^\d+@@/, ''),
        path: file.replace(/^\d+@@/, ''),
        size: 300000000
      })));
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
  if (!torrent.infoHash && !torrent.magnetLink) {
    return Promise.reject(new Error("no infoHash or magnetLink"));
  }
  return new Promise((resolve, rejected) => {
    const engine = new torrentStream(torrent.magnetLink || torrent.infoHash, { connections: MAX_PEER_CONNECTIONS });

    engine.ready(() => {
      const files = engine.files
          .map((file, fileId) => ({
            fileIndex: fileId,
            name: file.name,
            path: file.path.replace(/^[^\/]+\//, ''),
            size: file.length
          }));

      engine.destroy();
      resolve(files);
    });
    setTimeout(() => {
      engine.destroy();
      rejected(new Error('No available connections for torrent!'));
    }, 60000);
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

function dynamicTimeout(torrent) {
  if (torrent.seeders < 5) {
    return 5000;
  } else if (torrent.seeders < 10) {
    return 7000;
  } else if (torrent.seeders < 20) {
    return 10000;
  } else if (torrent.seeders < 30) {
    return 15000;
  } else if (torrent.seeders < 50) {
    return 20000;
  } else {
    return 30000;
  }
}

