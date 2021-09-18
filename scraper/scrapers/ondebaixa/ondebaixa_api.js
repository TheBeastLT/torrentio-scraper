const axios = require('axios');
const cheerio = require("cheerio");
const decode = require('magnet-uri');
const { escapeHTML } = require('../../lib/metadata');
const { getRandomUserAgent } = require('../../lib/requestHelper');
const { isPtDubbed, sanitizePtName, sanitizePtOriginalName, sanitizePtLanguages } = require('../scraperHelper')

const defaultTimeout = 10000;
const maxSearchPage = 50

const baseUrl = 'https://ondebaixa.com';

const Categories = {
  MOVIE: 'filmes',
  TV: 'series',
  ANIME: 'anime',
  DESENHOS: 'desenhos'
};

function torrent(torrentId, config = {}, retries = 2) {
  if (!torrentId || retries === 0) {
    return Promise.reject(new Error(`Failed ${torrentId} query`));
  }
  const slug = encodeURIComponent(torrentId.split("/")[3]);
  return singleRequest(`${baseUrl}/${slug}/`, config)
      .then((body) => parseTorrentPage(body))
      .then((torrent) => torrent.map(el => ({ torrentId: slug, ...el })))
      .catch((err) => {
        console.warn(`Failed OndeBaixo ${slug} request: `, err);
        return torrent(torrentId, config, retries - 1)
      });
}

function search(keyword, config = {}, retries = 2) {
  if (!keyword || retries === 0) {
    return Promise.reject(new Error(`Failed ${keyword} search`));
  }
  const page = config.page || 1;
  const extendToPage = Math.min(maxSearchPage, (config.extendToPage || 1))

  return singleRequest(`${baseUrl}/${keyword}/${page}/`, config)
      .then(body => parseTableBody(body))
      .then(torrents => torrents.length === 40 && page < extendToPage
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
  const requestUrl = category ? `${baseUrl}/${category}/${page}/` : `${baseUrl}/${page}/`;

  return singleRequest(requestUrl, config)
      .then((body) => parseTableBody(body))
      .catch((err) => browse(config, retries - 1));
}

function singleRequest(requestUrl, config = {}) {
  const timeout = config.timeout || defaultTimeout;
  const options = { headers: { 'User-Agent': getRandomUserAgent() }, timeout: timeout };

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
      });
}

function parseTableBody(body) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error('Failed loading body'));
    }

    const torrents = [];

    $('div.capa_larga.align-middle').each((i, element) => {
      const row = $(element);
      torrents.push({
        name: row.find("a").text(),
        torrentId: row.find("a").attr("href")
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
    const magnets = $(`a[href^="magnet"]`)
        .filter((i, elem) => isPtDubbed($(elem).attr('title')))
        .map((i, elem) => $(elem).attr("href")).get();
    const details = $('div#informacoes')
    const category = details.find('span:contains(\'Gêneros: \')').next().html()
    const torrents = magnets.map(magnetLink => {
      const decodedMagnet = decode(magnetLink);
      const name = escapeHTML(decodedMagnet.name || '').replace(/\+/g, ' ');
      const originalTitle = details.find('span:contains(\'Título Original: \')').next().text().trim();
      const year = details.find('span:contains(\'Ano de Lançamento: \')').next().text().trim();
      const fallbackTitle = `${originalTitle} ${year}`;
      return {
        title: name ? sanitizePtName(name) : fallbackTitle,
        originalName: sanitizePtOriginalName(originalTitle),
        year: year,
        infoHash: decodedMagnet.infoHash,
        magnetLink: magnetLink,
        category: parseCategory(category),
        uploadDate: new Date($('time').attr('datetime')),
        languages: sanitizePtLanguages(details.find('span:contains(\'Idioma\')').next().text())
      }
    });
    resolve(torrents.filter((x) => x));
  });
}

function parseCategory(body) {
  const $ = cheerio.load(body)
  if ($("a[href*='anime']").text()) {
    return Categories.ANIME
  }
  if ($("a[href*='series']").text()) {
    return Categories.TV
  }
  if ($("a[href*='filmes']").text()) {
    return Categories.MOVIE
  }
  if ($("a[href*='desenhos']").text()) {
    return Categories.TV
  }
}

module.exports = { torrent, search, browse, Categories };