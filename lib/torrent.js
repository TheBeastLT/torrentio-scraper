const torrentStream = require('torrent-stream');
const cheerio = require('cheerio');
const needle = require('needle');
const parseTorrent = require('parse-torrent');
const cloudscraper = require('cloudscraper');

const MAX_PEER_CONNECTIONS = process.env.MAX_PEER_CONNECTIONS || 20;
const EXTENSIONS = ["3g2", "3gp", "avi", "flv", "mkv", "mov", "mp2", "mp4", "mpe", "mpeg", "mpg", "mpv", "webm", "wmv"];

module.exports.torrentFiles = function(torrent) {
  return filesFromKat(torrent.infoHash)
      .catch(() => filesFromTorrentStream(torrent))
      .then((files) => files
          .filter((file) => isVideo(file))
          .map((file) => `${file.fileIndex}@@${file.path}`));
};

// async function filesFromBtSeeds(infoHash) {
//   const url = `https://www.btseed.net/show/${infoHash}`;
//   return needle('get', url, { open_timeout: 2000 })
//       .then((response) => response.body)
//       .then((body) => body.match(/<script id="__NEXT_DATA__"[^>]+>(.*?)<\/script>/)[1])
//       .then((match) => JSON.parse(match).props.pageProps.result.torrent.files)
// }

function filesFromKat(infoHash) {
  const url = `http://kat.rip/torrent/${infoHash}.html`;
  return needle('get', url, { open_timeout: 2000 })
      .then((response) => {
        if (!response.body) {
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
            path: $(row).find('td[class=\'torFileName\']').text(),
            size: convertToBytes($(row).find('td[class=\'torFileSize\']').text())
          });
        });
        return files;
      })
}

async function filesFromTorrentStream(torrent) {
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

      engine.destroy();
      resolve(files);
    });
    setTimeout(() => {
      engine.destroy();
      rejected(new Error('No available connections for torrent!'));
    }, dynamicTimeout(torrent));
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
    return 2000;
  } else if (torrent.seeders < 10) {
    return 3000;
  } else if (torrent.seeders < 20) {
    return 4000;
  } else if (torrent.seeders < 30) {
    return 5000;
  } else if (torrent.seeders < 50) {
    return 7000;
  } else if (torrent.seeders < 100) {
    return 10000;
  } else {
    return 15000;
  }
}

