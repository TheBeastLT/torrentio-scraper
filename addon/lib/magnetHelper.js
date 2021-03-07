const needle = require('needle');
const magnet = require('magnet-uri');
const { getRandomUserAgent } = require('../lib/requestHelper');
const { getTorrent } = require('../lib/repository');
const { Type } = require('../lib/types');

const TRACKERS_URL = 'https://ngosang.github.io/trackerslist/trackers_best.txt';
const ANIME_TRACKERS = [
  "http://nyaa.tracker.wf:7777/announce",
  "http://anidex.moe:6969/announce",
  "http://tracker.anirena.com:80/announce",
  "udp://tracker.uw0.xyz:6969/announce",
  "http://share.camoe.cn:8080/announce",
  "http://t.nyaatracker.com:80/announce"
];
let BEST_TRACKERS = [];
let ALL_TRACKERS = [];

function getAllTrackers() {
  return ALL_TRACKERS;
}

async function getMagnetLink(infoHash) {
  const torrent = await getTorrent(infoHash).catch(() => ({ infoHash }));
  const torrentTrackers = torrent.trackers && torrent.trackers.split(',');
  const animeTrackers = torrent.type === Type.ANIME ? ALL_TRACKERS : undefined;
  const trackers = torrentTrackers || animeTrackers;

  return trackers
      ? magnet.encode({ infoHash: infoHash, announce: trackers })
      : magnet.encode({ infoHash: infoHash });
}

async function initBestTrackers() {
  BEST_TRACKERS = await getBestTrackers();
  ALL_TRACKERS = BEST_TRACKERS.concat(ANIME_TRACKERS);
  console.log('Retrieved best trackers: ', BEST_TRACKERS);
}

async function getBestTrackers(retry = 2) {
  const options = { timeout: 30000, headers: { 'User-Agent': getRandomUserAgent() } };
  return needle('get', TRACKERS_URL, options)
      .then(response => response.body && response.body.trim())
      .then(body => body && body.split('\n\n') || [])
      .catch(error => {
        if (retry === 0) {
          console.log(`Failed retrieving best trackers: ${error.message}`);
          throw error;
        }
        return getBestTrackers(retry - 1);
      });
}

module.exports = { initBestTrackers, getAllTrackers, getMagnetLink };