const axios = require('axios');
const cheerio = require('cheerio');
const moment = require('moment');
const { decode } = require("magnet-uri");
const Promises = require('../../lib/promises');
const { getRandomUserAgent } = require('./../../lib/requestHelper');
const { parseSize } = require("../scraperHelper");

const defaultProxies = [
  'https://eztv.re'
];
const defaultTimeout = 120000;
const minDelay = 3000;
const jitterDelay = minDelay;
const limit = 100;
const maxPage = 5;

function torrent(torrentId, config = {}, retries = 1) {
  if (!torrentId) {
    return Promise.reject(new Error(`Failed ${torrentId} search`));
  }

  return Promises.first(defaultProxies
          .map(proxyUrl => singleRequest(`${proxyUrl}/ep/${torrentId}`, config)))
      .then(body => parseTorrentPage(body))
      .then(torrent => ({ torrentId, ...torrent }))
      .catch(error => retries ? jitter().then(() => torrent(torrentId, config, retries - 1)) : Promise.reject(error));
}

function search(imdbId, config = {}, retries = 1) {
  if (!imdbId) {
    return Promise.reject(new Error(`Failed ${imdbId} search`));
  }
  const id = imdbId.replace('tt', '');
  const page = config.page || 1;

  return Promises.first(defaultProxies
          .map(proxyUrl => singleRequest(`${proxyUrl}/api/get-torrents?limit=${limit}&page=${page}&imdb_id=${id}`, config)))
      .then(results => parseResults(results))
      .then(torrents => torrents.length === limit && page < maxPage
          ? search(imdbId, { ...config, page: page + 1 }).catch(() => [])
              .then(nextTorrents => torrents.concat(nextTorrents))
          : torrents)
      .catch(error => retries ? jitter().then(() => search(imdbId, config, retries - 1)) : Promise.reject(error));
}

function browse(config = {}, retries = 1) {
  const page = config.page || 1;

  return Promises.first(defaultProxies
          .map(proxyUrl => singleRequest(`${proxyUrl}/api/get-torrents?limit=${limit}&page=${page}`, config)))
      .then(results => parseResults(results))
      .catch(error => retries ? jitter().then(() => browse(config, retries - 1)) : Promise.reject(error));
}

function singleRequest(requestUrl, config = {}) {
  const timeout = config.timeout || defaultTimeout;
  const options = { headers: { 'User-Agent': getRandomUserAgent() }, timeout: timeout };

  return axios.get(requestUrl, options)
      .then(response => {
        if (!response.data) {
          return Promise.reject(`No body: ${requestUrl}`);
        }
        return Promise.resolve(response.data);
      });
}

function parseResults(results) {
  if (!results || !Array.isArray(results.torrents)) {
    return Promise.reject(`Incorrect results ${results}`)
  }
  return results.torrents.map(torrent => parseTorrent(torrent));
}

function parseTorrent(torrent) {
  return {
    name: torrent.title.replace(/EZTV$/, ''),
    torrentId: torrent.episode_url.replace(/.*\/ep\//, ''),
    infoHash: torrent.hash.trim().toLowerCase(),
    magnetLink: torrent.magnet_url,
    torrentLink: torrent.torrent_url,
    seeders: torrent.seeds,
    size: torrent.size_bytes,
    uploadDate: new Date(torrent.date_released_unix * 1000),
    imdbId: torrent.imdb_id !== '0' && 'tt' + torrent.imdb_id || undefined
  }
}

function parseTorrentPage(body) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error('Failed loading body'));
    }
    const content = $('table[class="forum_header_border_normal"]');
    const magnetLink = content.find('a[title="Magnet Link"]').attr('href');
    const torrent = {
      name: content.find('h1 > span').text().replace(/EZTV$/, ''),
      infoHash: decode(magnetLink).infoHash,
      magnetLink: magnetLink,
      torrentLink: content.find('a[title="Download Torrent"]').attr('href'),
      seeders: parseInt(content.find('span[class="stat_red"]').first().text(), 10) || 0,
      size: parseSize(content.find('b:contains(\'Filesize:\')')[0].nextSibling.data),
      uploadDate: moment(content.find('b:contains(\'Released:\')')[0].nextSibling.data, 'Do MMM YYYY').toDate(),
      showUrl: content.find('.episode_left_column a').attr('href')
    };
    resolve(torrent);
  });
}

function jitter() {
  return Promises.delay(minDelay + Math.round(Math.random() * jitterDelay))
}

module.exports = { torrent, search, browse };
