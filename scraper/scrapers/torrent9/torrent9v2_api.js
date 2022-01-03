const axios = require('axios');
const cheerio = require('cheerio');
const moment = require('moment');
const decode = require('magnet-uri');
const { parse } = require('parse-torrent-title');
const { getRandomUserAgent } = require('../../lib/requestHelper');
const { parseSize } = require("../scraperHelper");

const baseUrl = 'https://www.torrent9.gg'
const defaultTimeout = 10000;

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

  return singleRequest(`${baseUrl}/torrents_${category}.html,page-${page}`)
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

    $('tr').each((i, element) => {
      const row = $(element);
      const titleElement = row.find('td a');
      if (titleElement.length) {
        torrents.push({
          title: titleElement.attr('title').trim(),
          torrentId: titleElement.attr('href').match(/torrent\/(.*)/)[1],
          seeders: parseInt(row.find('span.seed_ok').first().text()),
        });
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
    const name = getName(details) || $('h1').text();
    const languages = parse(name).languages;
    const torrent = {
      title: name.trim(),
      infoHash: magnetLink ? decode(magnetLink).infoHash : undefined,
      magnetLink: magnetLink,
      seeders: parseInt(details.find('.movie-information ul:nth-of-type(1) li:nth-of-type(3)').text(), 10),
      category: details.find('ul:nth-of-type(4) a').attr('href').match(/_(\w+)\.html$/)[1],
      size: parseSize(details.find('ul:nth-of-type(2) li:nth-of-type(3)').text()),
      uploadDate: moment(details.find('ul:nth-of-type(3) li:nth-of-type(3)').text(), 'DD/MM/YYYY').toDate(),
      languages: languages && languages.includes('french') ? undefined : 'french',
    };
    resolve(torrent);
  });
}

function getName(details) {
  const nameElement = details.find('p strong');
  if (nameElement.length === 1) {
    return nameElement.contents().filter((_, elem) => elem.type === 'text').text()
  }
  const description = nameElement.parent().text();
  const nameMatch = description.match(
      /(?:[A-Z]+[^A-Z0-9]*|[A-Z0-9-]+(?:[a-z]+\d+)?)\.([\w-]+\.){3,}\w+(?:-\w+)?(?=[A-Z])/);
  return nameMatch && nameMatch[0];
}

module.exports = { torrent, browse, Categories };
