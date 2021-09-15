const needle = require("needle")
const moment = require("moment")
const cheerio = require("cheerio");
const decode = require('magnet-uri');
const Promises = require('../../lib/promises');
const { escapeHTML } = require('../../lib/metadata');
const { getRandomUserAgent } = require('../../lib/requestHelper');
const { isPtDubbed, sanitizePtName, sanitizePtLanguages, sanitizePtOriginalName } = require('../scraperHelper')

const defaultTimeout = 30000;
const maxSearchPage = 50

const baseUrl = 'https://comando.to';

const Categories = {
  MOVIE: 'filmes',
  TV: 'series',
  ANIME: 'animes',
  DOCUMENTARIES: 'documentario'
};

function torrent(torrentId, config = {}, retries = 2) {
  if (!torrentId || retries === 0) {
    return Promise.reject(new Error(`Failed ${torrentId} query`));
  }
  const slug = torrentId.split("/")[3];
  return singleRequest(`${baseUrl}/${slug}`, config)
      .then((body) => parseTorrentPage(body))
      .then((torrent) => torrent.map(el => ({ torrentId: slug, ...el })))
      .catch((err) => {
        console.warn(`Failed Comando ${slug} request: `, err);
        return torrent(slug, config, retries - 1)
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

  return singleRequest(`${baseUrl}/category/${category}/page/${page}/`, config)
      .then((body) => parseTableBody(body))
      .catch((err) => browse(config, retries - 1));
}

function singleRequest(requestUrl, config = {}) {
  const timeout = config.timeout || defaultTimeout;
  const options = { userAgent: getRandomUserAgent(), open_timeout: timeout, follow: 2 };

  return needle('get', requestUrl, options)
      .then((response) => {
        const body = response.body;
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

    $('article').each((i, element) => {
      const row = $(element);
      torrents.push({
        name: row.find("h2 > a").text(),
        torrentId: row.find("h2 > a").attr("href")
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
    const magnets = $('h2 > strong')
        .filter((i, elem) => isPtDubbed($(elem).text())).parent()
        .map((i, elem) => $(elem).nextUntil('h2, hr'))
        .map((i, elem) => $(elem).find('a[href^="magnet"]'))
        .map((i, section) => $(section).attr("href")).get();
    const details = $('strong, b').filter((i, elem) => $(elem).text().match(/Servidor|Orig(?:\.|inal)/)).parent();
    const imdbIdMatch = details.find('a[href*="imdb.com"]').attr('href')
    const torrents = magnets.map(magnetLink => {
      const decodedMagnet = decode(magnetLink);
      const originalNameElem = details.find('strong, b')
          .filter((i, elem) => $(elem).text().match(/Baixar|Orig(?:\.|inal)/));
      const languagesElem = details.find('strong, b')
          .filter((i, elem) => $(elem).text().match(/^\s*([IÍ]dioma|[AÁ]udio)/));
      const originalName = originalNameElem.next().text().trim() || originalNameElem[0].nextSibling.nodeValue;
      const title = decodedMagnet.name && escapeHTML(decodedMagnet.name.replace(/\+/g, ' '));
      return {
        title: title ? sanitizePtName(title) : originalName.replace(/: ?/, ''),
        originalName: sanitizePtOriginalName(originalName.replace(/: ?/, '')),
        year: details.find('a[href*="comando.to/category/"]').text(),
        infoHash: decodedMagnet.infoHash,
        magnetLink: magnetLink,
        category: parseCategory($('div.entry-categories').html()),
        uploadDate: new Date(moment($('a.updated').text(), 'LL', 'pt-br').format()),
        imdbId: imdbIdMatch ? imdbIdMatch.split('/')[4] : null,
        languages: sanitizePtLanguages(languagesElem[0].nextSibling.nodeValue)
      }
    });
    resolve(torrents.filter((x) => x));
  });
}

function parseCategory(categorys) {
  const $ = cheerio.load(categorys)
  if ($('a:contains(\'animes\')').text()) {
    return Categories.ANIME
  }
  if ($('a:contains(\'Filmes\')').text()) {
    return Categories.MOVIE
  }
  if ($('a:contains(\'Series\')').text()) {
    return Categories.TV
  }
}

module.exports = { torrent, search, browse, Categories };