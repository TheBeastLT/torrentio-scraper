const axios = require('axios');
const moment = require("moment")
const cheerio = require("cheerio");
const decode = require('magnet-uri');
const { escapeHTML } = require('../../lib/metadata');
const { getRandomUserAgent } = require('../../lib/requestHelper');
const { isPtDubbed, sanitizePtName, sanitizePtOriginalName, sanitizePtLanguages } = require('../scraperHelper')

const defaultTimeout = 10000;
const maxSearchPage = 50

const baseUrl = 'https://lapumia.org';

const Categories = {
  MOVIE: null,
  TV: 'series',
  ANIME: 'animes',
};

function torrent(torrentId, config = {}, retries = 2) {
  if (!torrentId || retries === 0) {
    return Promise.reject(new Error(`Failed ${torrentId} query`));
  }
  const slug = torrentId.split('?p=')[1];
  return singleRequest(`${baseUrl}/?p=${slug}`, config)
      .then((body) => parseTorrentPage(body))
      .then((torrent) => torrent.map(el => ({ torrentId: slug, ...el })))
      .catch((err) => {
        console.warn(`Failed Lapumia ${slug} request: `, err);
        return torrent(torrentId, config, retries - 1)
      });
}

function search(keyword, config = {}, retries = 2) {
  if (!keyword || retries === 0) {
    return Promise.reject(new Error(`Failed ${keyword} search`));
  }
  const page = config.page || 1;
  const extendToPage = Math.min(maxSearchPage, (config.extendToPage || 1))

  return singleRequest(`${baseUrl}/page/${page}/?s=${keyword}`, config)
      .then(body => parseTableBody(body))
      .then(torrents => torrents.length === 10 && page < extendToPage
          ? search(keyword, { ...config, page: page + 1 }).catch(() => [])
              .then(nextTorrents => torrents.concat(nextTorrents))
          : torrents)
      .catch((err) => search(keyword, config, retries - 1));
}

function browse(config = {}, retries = 2) {
  if (retries === 0) {
    return Promise.reject(new Error(`Failed browse request`));
  }
  const page = config.page || 1;
  const category = config.category;
  const requestUrl = category ? `${baseUrl}/${category}/page/${page}/` : `${baseUrl}/page/${page}/`

  return singleRequest(requestUrl, config)
      .then((body) => parseTableBody(body))
      .catch((err) => browse(config, retries - 1));
}

function singleRequest(requestUrl, config = {}) {
  const timeout = config.timeout || defaultTimeout;
  const options = { userAgent: getRandomUserAgent(), timeout: timeout, follow: 2 };

  return axios.get(requestUrl, options)
      .then((response) => {
        const body = response.data;
        if (!body) {
          throw new Error(`No body: ${requestUrl}`);
        } else if (body.includes('502: Bad gateway') ||
            body.includes('403 Forbidden')) {
          throw new Error(`Invalid body contents: ${requestUrl}`);
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

    $('div.post').each((i, element) => {
      const row = $(element);
      torrents.push({
        name: row.find("div > a").text(),
        torrentId: row.find("div > a").attr("href")
      });
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
    const magnets = $('h2 > span')
        .filter((i, elem) => isPtDubbed($(elem).text())).parent()
        .map((i, elem) => $(elem).nextUntil('h2, hr'))
        .map((i, elem) => $(elem).find('a[href^="magnet"]'))
        .map((i, section) => $(section).attr("href")).get();
    const category = parseCategory($('div.category').html());
    const details = $('div.content')
    const torrents = magnets.map(magnetLink => ({
      title: sanitizePtName(escapeHTML(decode(magnetLink).name.replace(/\+/g, ' '))),
      originalName: sanitizePtOriginalName(details.find('b:contains(\'Titulo Original:\')')[0].nextSibling.nodeValue),
      year: details.find('b:contains(\'Ano de Lançamento:\')')[0].nextSibling.nodeValue.trim(),
      infoHash: decode(magnetLink).infoHash,
      magnetLink: magnetLink,
      category: category,
      uploadDate: new Date(moment($('div.infos').text().split('•')[0].trim(), 'LL', 'pt-br').format()),
      imdbId: $('.imdbRatingPlugin').attr('data-title') || null,
      languages: sanitizePtLanguages(details.find('b:contains(\'Idioma\')')[0].nextSibling.nodeValue)
    }))
    resolve(torrents.filter((x) => x));
  });
}

function parseCategory(categorys) {
  const $ = cheerio.load(categorys)
  if ($('a:contains(\'Animes\')').text()) {
    return Categories.ANIME
  }
  if ($('a:contains(\'Series\')').text()) {
    return Categories.TV
  }
  return Categories.MOVIE
}

module.exports = { torrent, search, browse, Categories };