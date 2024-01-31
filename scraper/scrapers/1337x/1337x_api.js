const axios = require('axios');
const cheerio = require('cheerio');
const Sugar = require('sugar-date');
const decode = require('magnet-uri');
const Promises = require('../../lib/promises');
const { escapeHTML } = require('../../lib/metadata');
const { getRandomUserAgent } = require('../../lib/requestHelper');
const { parseSize } = require("../scraperHelper");

const defaultProxies = [
  'https://1337x.to'
];
const defaultTimeout = 50000;
const maxSearchPage = 50;

let FlaresolverrUserAgent = '';
let FlaresolverrCookies = '';

const Categories = {
  MOVIE: 'Movies',
  TV: 'TV',
  ANIME: 'Anime',
  DOCUMENTARIES: 'Documentaries',
  APPS: 'Apps',
  GAMES: 'Games',
  MUSIC: 'Music',
  PORN: 'XXX',
  OTHER: 'Other',
};

function torrent(torrentId, config = {}, retries = 2) {
  if (!torrentId || retries === 0) {
    return Promise.reject(new Error(`Failed ${torrentId} query`));
  }
  const proxyList = config.proxyList || defaultProxies;
  const slug = torrentId.startsWith('/torrent/') ? torrentId.replace('/torrent/', '') : torrentId;

  return Promises.first(proxyList
    .map((proxyUrl) => singleRequest(`${proxyUrl}/torrent/${slug}`, config)))
    .then((body) => parseTorrentPage(body))
    .then((torrent) => ({ torrentId: slug, ...torrent }))
    .catch((err) => torrent(slug, config, retries - 1));
}

function search(keyword, config = {}, retries = 2) {
  if (!keyword || retries === 0) {
    return Promise.reject(new Error(`Failed ${keyword} search`));
  }
  const proxyList = config.proxyList || defaultProxies;
  const page = config.page || 1;
  const category = config.category;
  const extendToPage = Math.min(maxSearchPage, (config.extendToPage || 1))
  const requestUrl = proxyUrl => category
    ? `${proxyUrl}/category-search/${keyword}/${category}/${page}/`
    : `${proxyUrl}/search/${keyword}/${page}/`;

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
  const sort = config.sort;
  const requestUrl = proxyUrl => sort
    ? `${proxyUrl}/sort-cat/${category}/${sort}/desc/${page}/`
    : `${proxyUrl}/cat/${category}/${page}/`;

  return Promises.first(proxyList
    .map((proxyUrl) => singleRequest(requestUrl(proxyUrl), config)))
    .then((body) => parseTableBody(body))
    .catch((err) => {
      console.error(err);
      browse(config, retries - 1);
    });
}

function singleRequest(requestUrl, config = {}) {
  const timeout = config.timeout || defaultTimeout;
  let options = { headers: { 'User-Agent': getRandomUserAgent() }, timeout: timeout };

  if (FlaresolverrUserAgent === '' || FlaresolverrCookies === '') {
    console.log("using flaresolverr");
    return axios.post('http://flaresolverr:8191/v1', {
      cmd: 'request.get',
      url: requestUrl,
    }, options)
      .then((response) => {
        if (response.data.status !== 'ok') {
          throw new Error(`FlareSolverr did not return status 'ok': ${response.data.message}`)
        }

        const body = response.data.solution.response;
        if (!body) {
          throw new Error(`No body: ${requestUrl}`);
        } else if (body.includes('502: Bad gateway') ||
          body.includes('403 Forbidden') ||
          !(body.includes('1337x</title>'))) {
          throw new Error(`Invalid body contents: ${requestUrl}`);
        }
        FlaresolverrUserAgent = response.data.solution.userAgent;
        response.data.solution.cookies.forEach(cookie => {
          FlaresolverrCookies = FlaresolverrCookies + `${cookie.name}=${cookie.value}; `;
        });

        return body;
      });
  }
  else {
    console.log("using direct request");
    options.headers['User-Agent'] = FlaresolverrUserAgent;
    options.headers['Cookie'] = FlaresolverrCookies;
    return axios.get(requestUrl, options)
      .then((response) => {
        const body = response.data;
        if (!body) {
          throw new Error(`No body: ${requestUrl}`);
        } else if (body.includes('502: Bad gateway') ||
          body.includes('403 Forbidden') ||
          !(body.includes('1337x</title>'))) {
          throw new Error(`Invalid body contents: ${requestUrl}`);
        }
        return body;
      })
  }
}

function parseTableBody(body) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error('Failed loading body'));
    }

    const torrents = [];

    $('.table > tbody > tr').each((i, element) => {
      const row = $(element);
      torrents.push({
        name: row.find('a').eq(1).text(),
        torrentId: row.find('a').eq(1).attr('href').replace('/torrent/', ''),
        seeders: parseInt(row.children('td.coll-2').text()),
        leechers: parseInt(row.children('td.coll-3').text()),
        size: parseSize(row.children('td.coll-4').text())
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

    const details = $('.torrent-detail-page');
    const magnetLink = details.find('a:contains(\'Magnet Download\')').attr('href');
    const imdbIdMatch = details.find('div[id=\'description\']').html().match(/imdb\.com\/title\/(tt\d+)/i);

    const torrent = {
      name: escapeHTML(decode(magnetLink).name.replace(/\+/g, ' ')),
      infoHash: decode(magnetLink).infoHash,
      magnetLink: magnetLink,
      seeders: parseInt(details.find('strong:contains(\'Seeders\')').next().text(), 10),
      leechers: parseInt(details.find('strong:contains(\'Leechers\')').next().text(), 10),
      category: details.find('strong:contains(\'Category\')').next().text(),
      languages: details.find('strong:contains(\'Language\')').next().text(),
      size: parseSize(details.find('strong:contains(\'Total size\')').next().text()),
      uploadDate: parseDate(details.find('strong:contains(\'Date uploaded\')').next().text()),
      imdbId: imdbIdMatch && imdbIdMatch[1],
      files: details.find('div[id=\'files\']').first().find('li')
        .map((i, elem) => $(elem).text())
        .map((i, text) => ({
          fileIndex: i,
          name: text.match(/^(.+)\s\(.+\)$/)[1].replace(/^.+\//g, ''),
          path: text.match(/^(.+)\s\(.+\)$/)[1],
          size: parseSize(text.match(/^.+\s\((.+)\)$/)[1])
        })).get()
    };
    resolve(torrent);
  });
}

function parseDate(dateString) {
  if (/decade.*ago/i.test(dateString)) {
    return Sugar.Date.create('10 years ago');
  }
  return Sugar.Date.create(dateString);
}

module.exports = { torrent, search, browse, Categories, FlaresolverrCookies, FlaresolverrUserAgent };
