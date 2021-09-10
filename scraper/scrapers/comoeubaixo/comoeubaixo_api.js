const needle = require("needle")
const cheerio = require("cheerio");
const decode = require('magnet-uri');
const Promises = require('../../lib/promises');
const { escapeHTML } = require('../../lib/metadata');
const { getRandomUserAgent } = require("../../lib/requestHelper");

const defaultTimeout = 10000;
const maxSearchPage = 50

const defaultProxies = [
  'https://comoeubaixo.com'
];

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
  const proxyList = config.proxyList || defaultProxies;
  const slug = torrentId.split("/")[3];
  return Promises.first(proxyList
      .map((proxyUrl) => singleRequest(`${proxyUrl}/${slug}/`, config)))
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
  const requestUrl = proxyUrl => `${proxyUrl}/${keyword}/${page}/`

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
  const requestUrl = proxyUrl => category ? `${proxyUrl}/${category}/${page}/` : `${proxyUrl}/${page}/`;

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
    let magnets = [];
    $(`a[href^="magnet"]`).each((i, section) => {
      let magnet = $(section).attr("href");
      magnets.push(magnet);
    });
    const details = $('div#informacoes')
    const category = details.find('strong:contains(\'Gêneros: \')').next().attr('href').split('/')[0]
    const isAnime = category === Categories.ANIME
    const torrent = magnets.map(magnetLink => {
      const name = escapeHTML(decode(magnetLink).name.replace(/\+/g, ' '))
      if(isDubled(name) || isAnime) {
        return {
          name: parseText(name),
          original_name: parseName(details.find('strong:contains(\'Baixar\')')[0].nextSibling.nodeValue.split('-')[0]),
          year: details.find('strong:contains(\'Data de Lançamento: \')').next().text().trim(),
          infoHash: decode(magnetLink).infoHash,
          magnetLink: magnetLink,
          category: category,
          uploadDate: new Date($('time').attr('datetime')),
          imdbId: details.find('a[href*="imdb.com"]').attr('href').split('/')[4],
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
  return false
}

function parseText(text) {
  return text
  .replace(/\n|\t/g, "")
  .replace(/1A|2A|3A|4A|5A|6A|7A|8A|9A/g, '')
  .replace(/COMOEUBAIXO.COM|COMANDO.TO|TEMPORADA|COMPLETA/g, '')
  .replace(/MKV|MP4/g, '')
  .replace(/[-]/g, '')
  .replace(/[.]/g, ' ')
  .trim()
  .replace(/ /g, '.')
  .trim()
}

module.exports = { torrent, search, browse, Categories };