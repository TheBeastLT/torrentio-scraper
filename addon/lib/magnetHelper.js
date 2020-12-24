const needle = require('needle');
const { getRandomProxy, getProxyAgent, getRandomUserAgent } = require('../lib/requestHelper');
const { cacheWrapProxy } = require('../lib/cache');

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

async function initBestTrackers() {
  const userAgent = getRandomUserAgent();
  const proxy = await cacheWrapProxy('moch', () => getRandomProxy()).catch(() => getRandomProxy());
  const agent = getProxyAgent(proxy);
  const options = { timeout: 30000, agent: agent, headers: { 'User-Agent': userAgent } };

  BEST_TRACKERS = await needle('get', TRACKERS_URL, options)
      .then(response => response.body && response.body.trim())
      .then(body => body && body.split('\n\n') || [])
      .catch(error => {
        console.log(`Failed retrieving best trackers: ${error.message}`);
        return [];
      });
  ALL_TRACKERS = BEST_TRACKERS.concat(ANIME_TRACKERS);
}

module.exports = { initBestTrackers, getAllTrackers };