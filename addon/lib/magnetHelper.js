const axios = require('axios');
const magnet = require('magnet-uri');
const { getRandomUserAgent } = require('../lib/requestHelper');
const { getTorrent } = require('../lib/repository');
const { Type } = require('../lib/types');

const TRACKERS_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt';
const ANIME_TRACKERS = [
  "http://nyaa.tracker.wf:7777/announce",
  "http://anidex.moe:6969/announce",
  "http://tracker.anirena.com:80/announce",
  "udp://tracker.uw0.xyz:6969/announce",
  "http://share.camoe.cn:8080/announce",
  "http://t.nyaatracker.com:80/announce"
];
const RUSSIAN_TRACKERS = [
  "udp://opentor.org:2710",
  "http://retracker.local/announce",
  "http://bt.t-ru.org/ann?magnet",
  "http://bt2.t-ru.org/ann?magnet",
  "http://bt3.t-ru.org/ann?magnet",
  "http://bt4.t-ru.org/ann?magnet"
]
// Some trackers have limits on original torrent trackers,
// where downloading ip has to seed the torrents for some amount of time,
// thus it doesn't work on mochs.
// So it's better to exclude them and try to download through DHT,
// as the torrent won't start anyway.
const LIMITED_PROVIDERS = [
  'Rutor'
];
const ANIME_PROVIDERS = [
  'HorribleSubs',
  'NyaaSi',
  'NyaaPantsu'
];
const RUSSIAN_PROVIDERS = [
  'Rutor',
  'Rutracker'
]
let BEST_TRACKERS = [];
let ALL_TRACKERS = [];

async function getMagnetLink(infoHash) {
  const torrent = await getTorrent(infoHash).catch(() => ({ infoHash }));
  const torrentTrackers = !LIMITED_PROVIDERS.includes(torrent.provider)
      && torrent.trackers && torrent.trackers.split(',');
  const animeTrackers = torrent.type === Type.ANIME ? ALL_TRACKERS : undefined;
  const providerTrackers = RUSSIAN_PROVIDERS.includes(torrent.provider) && RUSSIAN_TRACKERS;
  const trackers = unique([].concat(torrentTrackers).concat(animeTrackers).concat(providerTrackers));

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
  return axios.get(TRACKERS_URL, options)
      .then(response => response.data && response.data.trim())
      .then(body => body && body.split('\n\n') || [])
      .catch(error => {
        if (retry === 0) {
          console.log(`Failed retrieving best trackers: ${error.message}`);
          throw error;
        }
        return getBestTrackers(retry - 1);
      });
}

function getSources(trackersInput, infoHash) {
  if (!trackersInput) {
    return null;
  }
  const trackers = Array.isArray(trackersInput) ? trackersInput : trackersInput.split(',');
  return trackers.map(tracker => `tracker:${tracker}`).concat(`dht:${infoHash}`);
}

function enrichStreamSources(stream) {
  const match = stream.title.match(/⚙.* ([^ \n]+)/);
  const provider = match && match[1];
  if (ANIME_PROVIDERS.includes(provider)) {
    const sources = getSources(ALL_TRACKERS, stream.infoHash);
    return { ...stream, sources };
  }
  if (RUSSIAN_PROVIDERS.includes(provider)) {
    const sources = unique([].concat(stream.sources).concat(getSources(RUSSIAN_TRACKERS, stream.infoHash)));
    return { ...stream, sources };
  }
  return stream;
}

function unique(array) {
  return Array.from(new Set(array));
}

module.exports = { initBestTrackers, getMagnetLink, getSources, enrichStreamSources };