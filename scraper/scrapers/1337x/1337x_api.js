const cheerio = require('cheerio');
const needle = require('needle');
const Sugar = require('sugar-date');
const decode = require('magnet-uri');

const defaultProxies = [
  'https://1337x.to'
];
const defaultTimeout = 10000;

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

  return raceFirstSuccessful(proxyList
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

  return raceFirstSuccessful(proxyList
      .map((proxyUrl) => singleRequest(`${proxyUrl}/search/${keyword}/${page}/`, config)))
      .then((body) => parseTableBody(body))
      .catch((err) => search(keyword, config, retries - 1));
}

function browse(config = {}, retries = 2) {
  if (retries === 0) {
    return Promise.reject(new Error(`Failed browse request`));
  }
  const proxyList = config.proxyList || defaultProxies;
  const page = config.page || 1;
  const category = config.category;

  return raceFirstSuccessful(proxyList
      .map((proxyUrl) => singleRequest(`${proxyUrl}/cat/${category}/${page}/`, config)))
      .then((body) => parseTableBody(body))
      .catch((err) => browse(config, retries - 1));
}

function singleRequest(requestUrl, config = {}) {
  const timeout = config.timeout || defaultTimeout;

  return needle('get', requestUrl, { open_timeout: timeout, follow: 2 })
      .then((response) => {
        const body = response.body;
        if (!body) {
          throw new Error(`No body: ${requestUrl}`);
        } else if (body.includes('502: Bad gateway') ||
            body.includes('403 Forbidden') ||
            !(body.includes('1337x</title>'))) {
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
      name: decode(magnetLink).name.replace(/\+/g, ' '),
      infoHash: decode(magnetLink).infoHash,
      magnetLink: magnetLink,
      seeders: parseInt(details.find('strong:contains(\'Seeders\')').next().text(), 10),
      leechers: parseInt(details.find('strong:contains(\'Leechers\')').next().text(), 10),
      category: details.find('strong:contains(\'Category\')').next().text(),
      language: details.find('strong:contains(\'Language\')').next().text(),
      size: parseSize(details.find('strong:contains(\'Total size\')').next().text()),
      uploadDate: Sugar.Date.create(details.find('strong:contains(\'Date uploaded\')').next().text()),
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

function parseSize(sizeText) {
  if (!sizeText) {
    return undefined;
  }
  let scale = 1;
  if (sizeText.includes('GB')) {
    scale = 1024 * 1024 * 1024
  } else if (sizeText.includes('MB')) {
    scale = 1024 * 1024;
  } else if (sizeText.includes('KB')) {
    scale = 1024;
  }
  return Math.floor(parseFloat(sizeText) * scale);
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

module.exports = { torrent, search, browse, Categories };
