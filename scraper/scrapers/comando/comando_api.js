const needle = require("needle")
const moment = require("moment")
const cheerio = require("cheerio");
const decode = require('magnet-uri');
const Promises = require('../../lib/promises');
const { escapeHTML } = require('../../lib/metadata');
const { getRandomUserAgent } = require("../../lib/requestHelper");
moment.locale("pt-br"); 

const defaultTimeout = 10000;
const maxSearchPage = 50

const defaultProxies = [
  'https://comando.to'
];

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
  const proxyList = config.proxyList || defaultProxies;
  const slug = torrentId.split("/")[3];
  return Promises.first(proxyList
      .map((proxyUrl) => singleRequest(`${proxyUrl}/${slug}`, config)))
      .then((body) => parseTorrentPage(body))
      .then((torrent) => torrent.map(el => ({ torrentId: slug, ...el })))
      .catch((err) => torrent(slug, config, retries - 1));
}

function search(keyword, config = {}, retries = 2) {
  if (!keyword || retries === 0) {
    return Promise.reject(new Error(`Failed ${keyword} search`));
  }
  const proxyList = config.proxyList || defaultProxies;
  const page = config.page || 1;
  const extendToPage = Math.min(maxSearchPage, (config.extendToPage || 1))
  const requestUrl = proxyUrl => `${proxyUrl}/page/${page}/?s=${keyword}`

  return Promises.first(proxyList
      .map(proxyUrl => singleRequest(requestUrl(proxyUrl), config)))
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
  const proxyList = config.proxyList || defaultProxies;
  const page = config.page || 1;
  const category = config.category;
  const requestUrl = proxyUrl => `${proxyUrl}/category/${category}/page/${page}/`

  return Promises.first(proxyList
      .map((proxyUrl) => singleRequest(requestUrl(proxyUrl), config)))
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
    let magnets = [];
    $(`a[href^="magnet"]`).each((i, section) => {
      let magnet = $(section).attr("href");
      magnets.push(magnet);
    });
    const details = $('b:contains(\'Original\')').parent()
    const isAnime = parseCategory($('div.entry-categories').html()) === Categories.ANIME
    const imdbIdMatch = details.find('a[href*="imdb.com"]').attr('href')
    const torrent = magnets.map(magnetLink => {
      const name = escapeHTML(decode(magnetLink).name.replace(/\+/g, ' '))
      if(isDubled(name) || isAnime) {
        return {
          name: name.replace(/ /g, '.'),
          original_name: parseName(details.find('b:contains(\'Original\')')[0].nextSibling.nodeValue.replace(':', '')),
          year: details.find('a[href*="comando.to/category/"]').text(),
          infoHash: decode(magnetLink).infoHash,
          magnetLink: magnetLink,
          category: parseCategory($('div.entry-categories').html()),
          uploadDate: new Date(moment($('a.updated').text(), 'LL', true).format()),
          imdbId: imdbIdMatch ? imdbIdMatch.split('/')[4] : null
        };
      }
    })
    resolve(torrent.filter((x) => x));
  });
}

function parseName(name) {
  return name
  .replace(/S01|S02|S03|S04|S05|S06|S07|S08|S09/g, '')
  .trim()
}

function isDubled(name){
  name = name.toLowerCase()
  if(name.includes('dublado')){
    return true
  }
  if(name.includes('dual')){
    return true
  }
  if(name.includes('nacional')){
    return true
  }
  if(name.includes('multi')){
    return true
  }
  return false
}

function parseCategory(categorys) {
  const $ = cheerio.load(categorys)
  const isAnime = $('a:contains(\'animes\')').text()
  const isMovie = $('a:contains(\'Filmes\')').text()
  const isSerie = $('a:contains(\'Series\')').text()
  if(isAnime) {
    return Categories.ANIME
  } 
  if (isMovie) {
    return Categories.MOVIE
  } 
  if(isSerie) {
    return Categories.TV
  }
}

module.exports = { torrent, search, browse, Categories };