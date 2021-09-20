const axios = require('axios');
const cheerio = require('cheerio');
const moment = require('moment');
const decode = require('magnet-uri');
const { parse } = require('parse-torrent-title');
const { getRandomUserAgent } = require('../../lib/requestHelper');
const { parseSize } = require("../scraperHelper");

const baseUrl = 'https://www.torrent9.pw'
const defaultTimeout = 10000;
const pageSize = 50;

const Categories = {
  MOVIE: 'films',
  TV: 'series',
};

function torrent(torrentId, config = {}, retries = 2) {
  if (!torrentId || retries === 0) {
    return Promise.reject(new Error(`Failed ${torrentId} search`));
  }

  return singleRequest(`${baseUrl}/torrent/${torrentId}`)
      .then((body) => parseTorrentPage(body))
      .then((torrent) => ({ torrentId, ...torrent }))
      .catch((err) => {
        console.warn(`Failed Torrent9 ${torrentId} request: `, err);
        return torrent(torrentId, config, retries - 1)
      });
}

function browse(config = {}, retries = 2, error = null) {
  if (retries === 0) {
    return Promise.reject(error || new Error(`Failed browse request`));
  }
  const page = config.page || 1;
  const category = config.category;
  const offset = (page - 1) * pageSize + 1;

  return singleRequest(`${baseUrl}/torrents/${category}/${offset}`)
      .then((body) => parseTableBody(body))
      .catch((err) => browse(config, retries - 1, err));
}

function singleRequest(requestUrl) {
  const headers = {
    'user-agent': getRandomUserAgent(),
    'accept-encoding': 'gzip, deflate',
    'accept-language': 'en-GB,en;q=0.9,en-US;q=0.8,lt;q=0.7,ar;q=0.6,fr;q=0.5,de;q=0.4'
  };
  const options = { headers, timeout: defaultTimeout };

  return axios.get(requestUrl, options)
      .then(response => {
        const body = response.data;
        if (!body || !body.length) {
          throw new Error(`No body: ${requestUrl} with status ${response.status}`);
        }
        return body;
      })
      .catch(error => Promise.reject(error.message || error));
}

function parseTableBody(body) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error('Failed loading body'));
    }

    const torrents = [];

    $('tbody tr').each((i, element) => {
      const row = $(element);
      const titleElement = row.find('td a');
      try {
        torrents.push({
          name: titleElement.text().trim(),
          torrentId: titleElement.attr('href').match(/torrent\/(.*)/)[1],
          seeders: parseInt(row.find('span.seed_ok').first().text()),
        });
      } catch (e) {
        console.error('Failed parsing TorrentGalaxy row: ', e);
      }
    });

    resolve(torrents);
  });
}

function parseTorrentPage(body) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error('Failed loading body'));
    }
    const details = $('.movie-detail');
    const magnetLink = details.find('a[href^="magnet"]').first().attr('href');
    const torrentLink = details.find('div.download-btn:nth-of-type(1) a').first().attr('href');
    const name = details.find('p strong').contents().filter((_, e) => e.type === 'text').text() || $('h5, h1').text();
    const languages = parse(name).languages;
    const torrent = {
      title: name.trim(),
      infoHash: decode(magnetLink).infoHash,
      magnetLink: magnetLink,
      torrentLink: torrentLink ? `${baseUrl}${torrentLink}` : undefined,
      seeders: parseInt(details.find('.movie-information ul:nth-of-type(1) li:nth-of-type(3)').text(), 10),
      category: details.find('ul:nth-of-type(4) a').attr('href').match(/\/(\w+)$/)[1],
      size: parseSize(details.find('ul:nth-of-type(2) li:nth-of-type(3)').text()),
      uploadDate: moment(details.find('ul:nth-of-type(3) li:nth-of-type(3)').text(), 'DD/MM/YYYY').toDate(),
      languages: languages && languages.includes('french') ? undefined : 'french',
    };
    resolve(torrent);
  });
}

module.exports = { torrent, browse, Categories };
