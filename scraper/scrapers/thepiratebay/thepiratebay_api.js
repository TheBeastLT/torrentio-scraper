const cheerio = require('cheerio');
const needle = require('needle');
const moment = require('moment');
const decode = require('magnet-uri');
const Promises = require('../../lib/promises');

const defaultProxies = [
  // 'https://thepiratebay.org',
  'https://proxybay.pro',
  'https://ukpiratebayproxy.com',
  'https://thepiratebayproxy.info',
  'https://mypiratebay.co',
  'https://thepiratebay.asia',
];
const dumpUrl = '/static/dump/csv/';
const defaultTimeout = 10000;

const Categories = {
  AUDIO: {
    ALL: 100,
    MUSIC: 101,
    AUDIO_BOOKS: 102,
    SOUND_CLIPS: 103,
    FLAC: 104,
    OTHER: 199
  },
  VIDEO: {
    ALL: 200,
    MOVIES: 201,
    MOVIES_DVDR: 202,
    MUSIC_VIDEOS: 203,
    MOVIE_CLIPS: 204,
    TV_SHOWS: 205,
    HANDHELD: 206,
    MOVIES_HD: 207,
    TV_SHOWS_HD: 208,
    MOVIES_3D: 209,
    OTHER: 299
  },
  APPS: {
    ALL: 300,
    WINDOWS: 301,
    MAC: 302,
    UNIX: 303,
    HANDHELD: 304,
    IOS: 305,
    ANDROID: 306,
    OTHER_OS: 399
  },
  GAMES: {
    ALL: 400,
    PC: 401,
    MAC: 402,
    PSx: 403,
    XBOX360: 404,
    Wii: 405,
    HANDHELD: 406,
    IOS: 407,
    ANDROID: 408,
    OTHER: 499
  },
  PORN: {
    ALL: 500,
    MOVIES: 501,
    MOVIES_DVDR: 502,
    PICTURES: 503,
    GAMES: 504,
    MOVIES_HD: 505,
    MOVIE_CLIPS: 506,
    OTHER: 599
  },
  OTHER: {
    ALL: 600,
    E_BOOKS: 601,
    COMICS: 602,
    PICTURES: 603,
    COVERS: 604,
    PHYSIBLES: 605,
    OTHER: 699
  }
};

function torrent(torrentId, config = {}, retries = 2) {
  if (!torrentId || retries === 0) {
    return Promise.reject(new Error(`Failed ${torrentId} search`));
  }
  const proxyList = config.proxyList || defaultProxies;

  return Promises.first(proxyList
      .map((proxyUrl) => singleRequest(`${proxyUrl}/torrent/${torrentId}/`, config)
          .then((body) => parseTorrentPage(body))))
      .then((torrent) => ({ torrentId, ...torrent }))
      .catch((err) => torrent(torrentId, config, retries - 1));
}

function search(keyword, config = {}, retries = 2) {
  if (!keyword || retries === 0) {
    return Promise.reject(new Error(`Failed ${keyword} search`));
  }
  const proxyList = config.proxyList || defaultProxies;
  const page = config.page || 0;
  const category = config.category || 0;

  return Promises.first(proxyList
      .map((proxyUrl) => singleRequest(`${proxyUrl}/search/${keyword}/${page}/99/${category}`, config)
          .then((body) => parseBody(body))))
      .catch((err) => search(keyword, config, retries - 1));
}

function browse(config = {}, retries = 2) {
  if (retries === 0) {
    return Promise.reject(new Error(`Failed browse request`));
  }
  const proxyList = config.proxyList || defaultProxies;
  const page = config.page || 0;
  const category = config.category || 0;

  return Promises.first(proxyList
      .map((proxyUrl) => singleRequest(`${proxyUrl}/browse/${category}/${page}`, config)
          .then((body) => parseBody(body))))
      .catch((err) => browse(config, retries - 1));
}

function dumps(config = {}, retries = 2) {
  if (retries === 0) {
    return Promise.reject(new Error(`Failed dump search`));
  }
  const proxyList = config.proxyList || defaultProxies;

  return Promises.first(proxyList
      .map((proxyUrl) => singleRequest(`${proxyUrl}${dumpUrl}`, config)
          .then((body) => body.match(/(<a href="[^"]+">[^<]+<\/a>.+\d)/g)
              .map((group) => ({
                url: `${proxyUrl}${dumpUrl}` + group.match(/<a href="([^"]+)">/)[1],
                updatedAt: moment(group.match(/\s+([\w-]+\s+[\d:]+)\s+\d+$/)[1], 'DD-MMM-YYYY HH:mm').toDate()
              })))))
      .catch(() => dumps(config, retries - 1));
}

function singleRequest(requestUrl, config = {}) {
  const timeout = config.timeout || defaultTimeout;

  return needle('get', requestUrl, { open_timeout: timeout, follow: 2 })
      .then((response) => {
        const body = response.body;
        if (!body) {
          throw new Error(`No body: ${requestUrl}`);
        } else if (body.includes('Access Denied') && !body.includes('<title>The Pirate Bay')) {
          console.log(`Access Denied: ${requestUrl}`);
          throw new Error(`Access Denied: ${requestUrl}`);
        } else if (body.includes('502: Bad gateway') ||
            body.includes('403 Forbidden') ||
            body.includes('Database maintenance') ||
            body.includes('Origin DNS error') ||
            !(body.includes('<title>The Pirate Bay') || body.includes('TPB</title>') || body.includes(dumpUrl))) {
          throw new Error(`Invalid body contents: ${requestUrl}`);
        }
        return body;
      });
}

function parseBody(body) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error('Failed loading body'));
    }

    const torrents = [];

    $('table[id=\'searchResult\'] tr').each(function () {
      const name = $(this).find('.detLink').text();
      const sizeMatcher = $(this).find('.detDesc').text().match(/(?:,\s?Size\s)(.+),/);
      const magnetLink = $(this).find('a[title=\'Download this torrent using magnet\']').attr('href');
      if (!name || !sizeMatcher) {
        return;
      }
      torrents.push({
        name: name,
        magnetLink: magnetLink,
        infoHash: decode(magnetLink).infoHash,
        torrentId: $(this).find('.detLink').attr('href').match(/torrent\/([^/]+)/)[1],
        seeders: parseInt($(this).find('td[align=\'right\']').eq(0).text(), 10),
        leechers: parseInt($(this).find('td[align=\'right\']').eq(1).text(), 10),

        category: parseInt($(this).find('a[title=\'More from this category\']').eq(0).attr('href').match(/\d+$/)[0],
            10),
        subcategory: parseInt($(this).find('a[title=\'More from this category\']').eq(1).attr('href').match(/\d+$/)[0],
            10),
        size: parseSize(sizeMatcher[1])
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
    const details = $('div[id=\'details\']');
    const col1 = details.find('dl[class=\'col1\']');
    const imdbIdMatch = col1.html().match(/imdb\.com\/title\/(tt\d+)/i);

    const torrent = {
      name: $('div[id=\'title\']').text().trim(),
      seeders: parseInt(details.find('dt:contains(\'Seeders:\')').next().text(), 10),
      leechers: parseInt(details.find('dt:contains(\'Leechers:\')').next().text(), 10),
      magnetLink: details.find('a[title=\'Get this torrent\']').attr('href'),
      infoHash: decode(details.find('a[title=\'Get this torrent\']').attr('href')).infoHash,
      category: Categories.VIDEO.ALL,
      subcategory: parseInt(col1.find('a[title=\'More from this category\']').eq(0).attr('href').match(/\d+$/)[0], 10),
      size: parseSize(details.find('dt:contains(\'Size:\')').next().text().match(/(\d+)(?:.?Bytes)/)[1]),
      uploadDate: new Date(details.find('dt:contains(\'Uploaded:\')').next().text()),
      imdbId: imdbIdMatch && imdbIdMatch[1]
    };
    resolve(torrent);
  });
}

function parseSize(sizeText) {
  if (!sizeText) {
    return undefined;
  }
  let scale = 1;
  if (sizeText.includes('GiB')) {
    scale = 1024 * 1024 * 1024
  } else if (sizeText.includes('MiB')) {
    scale = 1024 * 1024;
  } else if (sizeText.includes('KiB')) {
    scale = 1024;
  }
  return Math.floor(parseFloat(sizeText) * scale);
}

module.exports = { torrent, search, browse, dumps, Categories };
