const torrentStream = require('torrent-stream');
const needle = require('needle');
const parseTorrent = require('parse-torrent');
const BTClient = require('bittorrent-tracker')
const async = require('async');
const decode = require('magnet-uri');
const { Type } = require('./types');
const { delay } = require('./promises')
const { isVideo, isSubtitle } = require('./extension');
const { cacheTrackers } = require('./cache');

const TRACKERS_URL = 'https://ngosang.github.io/trackerslist/trackers_all.txt';
const MAX_PEER_CONNECTIONS = process.env.MAX_PEER_CONNECTIONS || 20;
const SEEDS_CHECK_TIMEOUT = 15 * 1000; // 15 secs
const ADDITIONAL_TRACKERS = [
  'http://tracker.trackerfix.com:80/announce',
  'udp://9.rarbg.me:2780',
  'udp://9.rarbg.to:2870'
];
const ANIME_TRACKERS = [
  "http://nyaa.tracker.wf:7777/announce",
  "udp://anidex.moe:6969/announce",
  "udp://tracker-udp.anirena.com:80/announce",
  "udp://tracker.uw0.xyz:6969/announce"
];

async function updateCurrentSeeders(torrentsInput) {
  return new Promise(async (resolve) => {
    const torrents = Array.isArray(torrentsInput) ? torrentsInput : [torrentsInput];
    const perTorrentResults = Object.fromEntries(new Map(torrents.map(torrent => [torrent.infoHash, {}])));
    const perTrackerInfoHashes = await Promise.all(torrents.map(torrent => getTorrentTrackers(torrent)
        .then(torrentTrackers => ({ infoHash: torrent.infoHash, trackers: torrentTrackers }))))
        .then(allTorrentTrackers => allTorrentTrackers
            .reduce((allTrackersMap, torrentTrackers) => {
              torrentTrackers.trackers.forEach(tracker =>
                  allTrackersMap[tracker] = (allTrackersMap[tracker] || []).concat(torrentTrackers.infoHash));
              return allTrackersMap;
            }, {}));
    let successCounter = 0;
    const callback = () => {
      console.log(`Total successful tracker responses: ${successCounter}`)
      resolve(perTorrentResults);
    }
    setTimeout(callback, SEEDS_CHECK_TIMEOUT);

    async.each(Object.keys(perTrackerInfoHashes), function (tracker, ready) {
      BTClient.scrape({ infoHash: perTrackerInfoHashes[tracker], announce: tracker }, (error, response) => {
        if (response) {
          const results = Array.isArray(torrentsInput) ? Object.entries(response) : [[response.infoHash, response]];
          results
              .filter(([infoHash]) => perTorrentResults[infoHash])
              .forEach(([infoHash, seeders]) =>
                  perTorrentResults[infoHash][tracker] = [seeders.complete, seeders.incomplete])
          successCounter++;
        } else if (error) {
          perTrackerInfoHashes[tracker]
              .filter(infoHash => perTorrentResults[infoHash])
              .forEach(infoHash => perTorrentResults[infoHash][tracker] = [0, 0, error.message])
        }
        ready();
      })
    }, callback);
  }).then(perTorrentResults => {
    const torrents = Array.isArray(torrentsInput) ? torrentsInput : [torrentsInput];
    torrents.forEach(torrent => {
      const results = perTorrentResults[torrent.infoHash];
      const newSeeders = Math.max(...Object.values(results).map(values => values[0]).concat(0));
      if (torrent.seeders !== newSeeders) {
        console.log(`Updating seeders for [${torrent.infoHash}] ${torrent.title} - ${torrent.seeders} -> ${newSeeders}`)
        torrent.seeders = newSeeders;
      }
    })
    return torrentsInput;
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
  if (Array.isArray(torrent.files)) {
    return Promise.resolve(torrent.files);
  }
  if (typeof torrent.files === 'function') {
    return torrent.files();
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
  const magnet = torrent.magnetLink || decode.encode({ infoHash: torrent.infoHash, announce: torrent.trackers });
  return new Promise((resolve, rejected) => {
    const engine = new torrentStream(magnet, { connections: MAX_PEER_CONNECTIONS });

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
  const isSample = video => video.path.match(/sample|bonus/i) && maxSize / parseInt(video.size) > minSampleRatio;
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

async function getTorrentTrackers(torrent) {
  const magnetTrackers = torrent.magnetLink && decode(torrent.magnetLink).tr || [];
  const torrentTrackers = torrent.trackers && torrent.trackers.split(',') || [];
  const defaultTrackers = await getDefaultTrackers(torrent);
  return Array.from(new Set([].concat(magnetTrackers).concat(torrentTrackers).concat(defaultTrackers)));
}

async function getDefaultTrackers(torrent, retry = 3) {
  return cacheTrackers(() => needle('get', TRACKERS_URL, { open_timeout: SEEDS_CHECK_TIMEOUT })
      .then(response => response.body && response.body.trim())
      .then(body => body && body.split('\n\n') || []))
      .catch(() => retry > 0 ? delay(5000).then(() => getDefaultTrackers(torrent, retry - 1)) : [])
      .then(trackers => trackers.concat(ADDITIONAL_TRACKERS))
      .then(trackers => torrent.type === Type.ANIME ? trackers.concat(ANIME_TRACKERS) : trackers);
}

module.exports = { updateCurrentSeeders, updateTorrentSize, sizeAndFiles, torrentFiles }
