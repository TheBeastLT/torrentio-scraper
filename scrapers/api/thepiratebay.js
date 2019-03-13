const cheerio = require('cheerio');
const needle = require('needle');
const moment = require('moment');

const defaultProxies = ['https://pirateproxy.sh', 'https://thepiratebay.org'];
const dumpUrl = '/static/dump/csv/';
const defaultTimeout = 5000;

const errors = {
  REQUEST_ERROR: { code: 'REQUEST_ERROR' },
  PARSER_ERROR: { code: 'PARSER_ERROR' }
};

Categories = {
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

function search(keyword, config = {}, retries = 2) {
  if (!keyword || retries === 0) {
    return Promise.reject(new Error(`Failed ${keyword} search`));
  }
  const proxyList = config.proxyList || defaultProxies;
  const page = config.page || 0;
  const category = config.cat || 0;

  return raceFirstSuccessful(proxyList
      .map((proxyUrl) => singleRequest(`${proxyUrl}/search/${keyword}/${page}/99/${category}`, config)))
      .then((body) => parseBody(body))
      .catch(() => search(keyword, config, retries - 1));
}

function dumps(config = {}, retries = 2) {
  if (retries === 0) {
    return Promise.reject(new Error(`Failed dump search`));
  }
  const proxyList = config.proxyList || defaultProxies;

  return raceFirstSuccessful(proxyList
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

  return new Promise(((resolve, reject) => {
    needle.get(requestUrl,
        { open_timeout: timeout, follow: 2 },
        (err, res, body) => {
          if (err || !body) {
            reject(err || errors.REQUEST_ERROR);
          } else if (body.includes('Access Denied') && !body.includes('<title>The Pirate Bay')) {
            console.log(`Access Denied: ${url}`);
            reject(new Error(`Access Denied: ${url}`));
          } else if (body.includes('502: Bad gateway') ||
            body.includes('403 Forbidden') ||
            body.includes('Database maintenance') ||
            body.includes('Origin DNS error') ||
            !body.includes('<title>The Pirate Bay')) {
            reject(errors.REQUEST_ERROR);
          }

          resolve(body);
        });
  }));
}

function parseBody(body) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error(errors.PARSER_ERROR));
    }

    const torrents = [];

    $('table[id=\'searchResult\'] tr').each(function() {
      const name = $(this).find('.detLink').text();
      if (!name) {
        return;
      }
      torrents.push({
        name: name,
        seeders: parseInt($(this).find('td[align=\'right\']').eq(0).text(), 10),
        leechers: parseInt($(this).find('td[align=\'right\']').eq(1).text(), 10),
        magnetLink: $(this).find('a[title=\'Download this torrent using magnet\']').attr('href'),
        category: parseInt($(this).find('a[title=\'More from this category\']').eq(0).attr('href').match(/\d+$/)[0], 10),
        subcategory: parseInt($(this).find('a[title=\'More from this category\']').eq(1).attr('href').match(/\d+$/)[0], 10)
      });
    });
    resolve(torrents);
  });
}

function raceFirstSuccessful(promises) {
  return Promise.all(promises.map((p) => {
    // If a request fails, count that as a resolution so it will keep
    // waiting for other possible successes. If a request succeeds,
    // treat it as a rejection so Promise.all immediately bails out.
    return p.then(
        (val) => Promise.reject(val),
        (err) => Promise.resolve(err)
    );
  })).then(
      // If '.all' resolved, we've just got an array of errors.
      (errors) => Promise.reject(errors),
      // If '.all' rejected, we've got the result we wanted.
      (val) => Promise.resolve(val)
  );
}

module.exports = { search, dumps, Categories };
