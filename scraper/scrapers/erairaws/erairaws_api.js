const needle = require("needle");
const axios = require('axios');
const cheerio = require("cheerio");
const decode = require("magnet-uri");
const Promises = require("../../lib/promises");
const { getRandomUserAgent } = require("../../lib/requestHelper");

const defaultTimeout = 10000;

const baseUrl = 'https://www.erai-raws.info';

const Categories = {
  ANIMES: 'anime',
  EPISODES: 'episodes'
};

function browse(config = {}, retries = 2) {
  if (retries === 0) {
    return Promise.reject(new Error(`Failed browse request`));
  }
  const page = config.page || 1;
  const category = config.category;

  return singleRequest(`${baseUrl}/${category}/page/${page}/`, config)
      .then((body) => parseTableBody(body)
          .then(animes => Promises.sequence(animes.map(anime => () => singleRequest(anime.animeLink))))
          .then(animeBodies => Promise.all(animeBodies.map(animeBody => parseTorrentPage(animeBody))))
          .then(animeInfos => animeInfos.reduce((a, b) => a.concat(b), [])))
      .catch((err) => browse(config, retries - 1));
}

function singleRequest(requestUrl, config = {}) {
  const timeout = config.timeout || defaultTimeout;
  const options = { userAgent: getRandomUserAgent(), timeout: timeout, follow: 2, };

  return axios.get(requestUrl, options).then((response) => {
    const body = response.data;
    if (!body || (Buffer.isBuffer(body) && !body.size)) {
      throw new Error(`No body: ${requestUrl}`);
    } else if (
        body.includes("502: Bad gateway") ||
        body.includes("403 Forbidden")
    ) {
      throw new Error(`Invalid body contents: ${requestUrl}`);
    }
    return body;
  });
}

function parseTableBody(body) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error("Failed loading body"));
    }

    const links = $('[itemprop=\'headline\'] a, .content-area a.aa_ss_ops_new')
        .map((i, element) => ({
          name: $(element).text(),
          animeLink: $(element).attr("href"),
        })).get();
    resolve(links);
  });
}

function parseTorrentPage(body) {
  return new Promise(async (resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error("Failed loading body"));
    }
    const entries = $('.tab-content table, .content-area table')
        .map((i, entry) => {
          const languages = $(entry).find('.tooltip3').map((_, l) => $(l).attr('data-title')).get().join('/');
          const magnets = $(entry).find('a[href^="magnet"]').map((_, m) => $(m).attr('href')).get();
          return { languages, magnets }
        }).get();
    const torrents = entries
        .map(entry => entry.magnets
            .map(magnet => decode(magnet))
            .map(decodedMagnet => ({
              title: decodedMagnet.name,
              infoHash: decodedMagnet.infoHash,
              trackers: decodedMagnet.tr,
              languages: entry.languages
            })))
        .reduce((a, b) => a.concat(b), []);
    resolve(torrents);
  });
}

module.exports = { browse, Categories };
