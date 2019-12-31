const torrentStream = require('torrent-stream');
const cheerio = require('cheerio');
const needle = require('needle');
const parseTorrent = require('parse-torrent');
const Tracker = require("peer-search/tracker");
const { retrieveTorrentFiles } = require('./cache');

const MAX_PEER_CONNECTIONS = process.env.MAX_PEER_CONNECTIONS || 20;
const EXTENSIONS = ["3g2", "3gp", "avi", "flv", "mkv", "mov", "mp2", "mp4", "mpe", "mpeg", "mpg", "mpv", "webm", "wmv"];
let TRACKERS = [];

module.exports.init = async function() {
  TRACKERS = await getTrackerList();
};

module.exports.torrentFiles = function(torrent) {
  return filesFromTorrentFile(torrent)
      .catch(() => filesFromKat(torrent.infoHash))
      .catch(() => filesFromTorrentStream(torrent))
      .catch(() => filesFromCache(torrent.infoHash))
      .then((files) => files.filter((file) => isVideo(file)));
};

module.exports.currentSeeders = function (torrent) {
  if (!torrent.infoHash) {
    return Promise.reject(new Error("no infoHash"));
  }
  return new Promise((resolve) =>
    Promise.all(TRACKERS.map((tracker) => new Promise((resolve) => {
          const t = new Tracker(tracker, { }, torrent.infoHash);
          t.run();
          t.on("info", (inf) => resolve([inf.seeders, inf.leechers]));
          setTimeout(() => resolve([0, 0]), 1000);
        }))
    ).then((results) => resolve(results.reduce((seeders, next) => seeders + next[0], 0)))
  );
};

// async function filesFromBtSeeds(infoHash) {
//   const url = `https://www.btseed.net/show/${infoHash}`;
//   return needle('get', url, { open_timeout: 2000 })
//       .then((response) => response.body)
//       .then((body) => body.match(/<script id="__NEXT_DATA__"[^>]+>(.*?)<\/script>/)[1])
//       .then((match) => JSON.parse(match).props.pageProps.result.torrent.files)
// }

function filesFromCache(infoHash) {
  return retrieveTorrentFiles(infoHash)
      .then((files) => files.map((file) => ({
        fileIndex: parseInt(file.match(/^(\d+)@@/)[1]),
        name: file.replace(/.+\/|^\d+@@/, ''),
        path: file.replace(/^\d+@@/, ''),
        size: 300000000
      })));
}

function filesFromKat(infoHash) {
  if (!infoHash) {
    return Promise.reject(new Error("no infoHash"));
  }
  const url = `https://kat.rip/torrent/${infoHash}.html`;
  return needle('get', url, { open_timeout: 2000 })
      .then((response) => {
        if (!response.body || response.statusCode !== 200) {
          throw new Error('torrent not found in kat')
        }
        return response.body
      })
      .then((body) => {
        const $ = cheerio.load(body);
        const files = [];

        $('table[id=\'ul_top\'] tr').each((index, row) => {
          files.push({
            fileIndex: index,
            name: $(row).find('td[class=\'torFileName\']').text().replace(/.*\//, ''),
            path: $(row).find('td[class=\'torFileName\']').text(),
            size: convertToBytes($(row).find('td[class=\'torFileSize\']').text())
          });
        });

        if (!files[files.length - 1].size) {
          throw new Error('not full file list')
        }
        return files;
      })
}

async function filesFromTorrentFile(torrent) {
  if (!torrent.torrentLink) {
    return Promise.reject(new Error("no torrentLink"));
  }

  needle('get', torrent.torrentLink, { open_timeout: 2000 })
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
    }, 30000);
  });
}

function isVideo(title) {
  return EXTENSIONS.includes(title.path.match(/\.(\w{2,4})$/)[1]);
}

function convertToBytes(sizeString) {
  if (!sizeString) {
    return;
  }
  const prefix = sizeString.match(/\w+$/)[0].toLowerCase();
  let multiplier = 1;
  if (prefix === 'gb') multiplier = 1024 * 1024 * 1024;
  else if (prefix === 'mb') multiplier = 1024 * 1024;
  else if (prefix === 'kb') multiplier = 1024;

  return Math.floor(parseFloat(sizeString) * multiplier);
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

function getTrackerList() {
  return needle('get', 'https://torrents.me/tracker-list/', { open_timeout: 2000, follow_max: 2 })
      .then((response) => {
        if (!response.body || response.statusCode !== 200) {
          throw new Error('tracker list not found')
        }
        return response.body
      })
      .then((body) => cheerio.load(body))
      .then(($) => $('div[class="small-12 columns"] pre').text())
      .then((text) => text.replace(/"/g, '').trim().split('\n'))
}

