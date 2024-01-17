const axios = require('axios');
const cheerio = require('cheerio');
const moment = require('moment');
const decode = require('magnet-uri');
const Promises = require('../../lib/promises');
const { getRandomUserAgent } = require('../../lib/requestHelper');
const { parseSize } = require("../scraperHelper");

const defaultProxies = [
  // 'https://torrentgalaxy.to',
  // 'https://torrentgalaxy.mx',
  'https://torrentgalaxy.su'
];
const defaultTimeout = 10000;

const Categories = {
  ANIME: '28',
  MOVIE_4K: '3',
  MOVIE_PACKS: '4',
  MOVIE_SD: '1',
  MOVIE_HD: '42',
  MOVIE_CAM: '45',
  MOVIE_BOLLYWOOD: '46',
  TV_SD: '5',
  TV_HD: '41',
  TV_PACKS: '6',
  TV_SPORT: '7',
  DOCUMENTARIES: '9'
};

function torrent(torrentId, config = {}, retries = 2) {
  if (!torrentId || retries === 0) {
    return Promise.reject(new Error(`Failed ${torrentId} search`));
  }
  const proxyList = config.proxyList || defaultProxies;

  return Promises.first(proxyList
          .map((proxyUrl) => singleRequest(`${proxyUrl}/torrent/${torrentId}`)))
      .then((body) => parseTorrentPage(body))
      .then((torrent) => ({ torrentId, ...torrent }))
      .catch((err) => torrent(torrentId, config, retries - 1));
}

function search(keyword, config = {}, retries = 2) {
  if (!keyword || retries === 0) {
    return Promise.reject(new Error(`Failed ${keyword} search`));
  }
  const proxyList = config.proxyList || defaultProxies;
  const page = config.page || 1;
  const category = config.category;

  return Promises.first(proxyList
          .map((proxyUrl) => singleRequest(`${proxyUrl}/torrents.php?cat=${category}&page=${page - 1}&search=${keyword}`)))
      .then((body) => parseTableBody(body))
      .catch(() => search(keyword, config, retries - 1));
}

function browse(config = {}, retries = 2, error = null) {
  if (retries === 0) {
    return Promise.reject(error || new Error(`Failed browse request`));
  }
  const proxyList = config.proxyList || defaultProxies;
  const page = config.page || 1;
  const category = config.category;

  return Promises.first(proxyList
          .map((proxyUrl) => singleRequest(`${proxyUrl}/torrents.php?cat=${category}&page=${page - 1}`)))
      .then((body) => parseTableBody(body))
      .catch((err) => browse(config, retries - 1, err));
}

function singleRequest(requestUrl) {
  const options = { headers: { 'User-Agent': getRandomUserAgent() }, timeout: defaultTimeout };

  return axios.get(requestUrl, options)
      .then((response) => {
        const body = response.data;
        if (!body) {
          throw new Error(`No body: ${requestUrl} with status ${response.status}`);
        } else if (body.includes('Access Denied')) {
          console.log(`Access Denied: ${requestUrl}`);
          throw new Error(`Access Denied: ${requestUrl}`);
        } else if (body.includes('502: Bad gateway') ||
            body.includes('403 Forbidden') ||
            body.includes('Origin DNS error')) {
          throw new Error(`Invalid body contents: ${requestUrl}`);
        }
        return body;
      });
}

function parseTableBody(body) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error('Failed loading body'));
    }

    const torrents = [];

    $('.tgxtable > div').each((i, element) => {
      if (i === 0) return;
      const row = $(element);
      const magnetLink = row.find('div:nth-of-type(n+2) .collapsehide > a:nth-of-type(2)').attr('href');
      const imdbIdMatch = row.html().match(/search=(tt\d+)/i);
      try {
        torrents.push({
          name: row.find('.tgxtablecell div a[title]').first().text(),
          infoHash: decode(magnetLink).infoHash,
          magnetLink: magnetLink,
          torrentLink: row.find('div:nth-of-type(n+2) .collapsehide > a:nth-of-type(1)').first().attr('href'),
          torrentId: row.find('.tgxtablecell div a[title]').first().attr('href').match(/torrent\/(\d+)/)[1],
          verified: !!row.find('i.fa-check').length,
          category: row.find('div:nth-of-type(n+2) .shrink a').first().attr('href').match(/cat=(\d+)$/)[1],
          seeders: parseInt(row.find('div:nth-of-type(n+2) .collapsehide [color=\'green\'] b').first().text()),
          leechers: parseInt(row.find('div:nth-of-type(n+2) .collapsehide [color=\'#ff0000\'] b').first().text()),
          languages: row.find('.tgxtablecell img[title]').first().attr('title'),
          size: parseSize(row.find('.collapsehide span.badge-secondary').first().text()),
          uploadDate: parseDate(row.find('div.collapsehide:nth-of-type(12)').first().text()),
          imdbId: imdbIdMatch && imdbIdMatch[1],
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
    const content = $('div[class="torrentpagetable limitwidth"]').first();
    const magnetLink = $('a[class="btn btn-danger"]').attr('href');
    const imdbIdContent = $('a[title="IMDB link"]').attr('href');
    const imdbIdMatch = imdbIdContent && imdbIdContent.match(/imdb\.com\/title\/(tt\d+)/i);

    const torrent = {
      name: content.find('.linebreakup a').first().text(),
      infoHash: decode(magnetLink).infoHash,
      magnetLink: magnetLink,
      verified: !content.find('i.fa-exclamation-triangle').length,
      torrentLink: $('a[class="btn btn-success"]').attr('href'),
      seeders: parseInt(content.find('font[color=\'green\']').first().text(), 10),
      category: content.find('div:nth-of-type(4) a:nth-of-type(2)').first().attr('href').match(/cat=(\d+)$/)[1],
      languages: content.find('div:nth-of-type(5) div:nth-of-type(2)').first().text().trim(),
      size: parseSize(content.find('div:nth-of-type(6) div:nth-of-type(2)').first().text()),
      uploadDate: parseDate(content.find('div:nth-of-type(9) div:nth-of-type(2)').first().text()),
      imdbId: imdbIdMatch && imdbIdMatch[1],
    };
    resolve(torrent);
  });
}

function parseDate(dateString) {
  if (dateString.includes('ago')) {
    const amount = parseInt(dateString, 10);
    const unit = dateString.includes('Min') ? 'minutes' : 'hours';
    return moment().subtract(amount, unit).toDate();
  }
  const preparedDate = dateString.replace(/\//g, '-').replace(/-(\d{2})\s/, '-20$1 ')
  return moment(preparedDate, 'DD-MM-YYYY HH:mm').toDate();
}

module.exports = { torrent, search, browse, Categories };
