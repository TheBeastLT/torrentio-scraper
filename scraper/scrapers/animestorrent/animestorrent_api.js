const needle = require("needle");
const cheerio = require("cheerio");
const decode = require("magnet-uri");
const Promises = require("../../lib/promises");
const { getRandomUserAgent } = require("../../lib/requestHelper");

const defaultTimeout = 10000;
const maxSearchPage = 50;

const baseUrl = 'https://animestorrent.com';

const Categories = {
  MOVIE: 'filme',
  ANIME: 'tv',
  OVA: 'ova'
};

function torrent(torrentId, config = {}, retries = 2) {
  if (!torrentId || retries === 0) {
    return Promise.reject(new Error(`Failed ${torrentId} query`));
  }
  const slug = torrentId.split("/")[3];
  return singleRequest(`${baseUrl}/${slug}`, config)
      .then((body) => parseTorrentPage(body))
      .then((torrent) => torrent.map((el) => ({ torrentId: slug, ...el })))
      .catch((err) => torrent(slug, config, retries - 1));
}

function search(keyword, config = {}, retries = 2) {
  if (!keyword || retries === 0) {
    return Promise.reject(new Error(`Failed ${keyword} search`));
  }
  const page = config.page || 1;
  const extendToPage = Math.min(maxSearchPage, config.extendToPage || 1);

  return singleRequest(`${baseUrl}/page/${page}/?s=${keyword}`, config)
      .then((body) => parseTableBody(body))
      .then((torrents) =>
          torrents.length === 40 && page < extendToPage
              ? search(keyword, { ...config, page: page + 1 })
                  .catch(() => [])
                  .then((nextTorrents) => torrents.concat(nextTorrents))
              : torrents)
      .catch((err) => search(keyword, config, retries - 1));
}

function browse(config = {}, retries = 2) {
  if (retries === 0) {
    return Promise.reject(new Error(`Failed browse request`));
  }
  const page = config.page || 1;
  const category = config.category;
  const requestUrl = category ? `${baseUrl}/tipo/${category}/page/${page}/` : `${baseUrl}/page/${page}/`;

  return singleRequest(requestUrl, config)
      .then((body) => parseTableBody(body))
      .catch((err) => browse(config, retries - 1));
}

function singleRequest(requestUrl, config = {}) {
  const timeout = config.timeout || defaultTimeout;
  const options = {
    userAgent: getRandomUserAgent(),
    open_timeout: timeout,
    follow: 2,
  };

  return needle("get", requestUrl, options).then((response) => {
    const body = response.body;
    if (!body) {
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

    const torrents = [];

    $("article.bs").each((i, element) => {
      const row = $(element);
      torrents.push({
        name: row.find("span.ntitle").text(),
        torrentId: row.find("div > a").attr("href"),
      });
    });
    resolve(torrents);
  });
}

function parseTorrentPage(body) {
  return new Promise(async (resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error("Failed loading body"));
    }
    let magnets = [];
    $(`a[href^="magnet"]`).each((i, section) => {
      const magnet = $(section).attr("href");
      magnets.push(magnet);
    });
    const details = $('div.infox')
    const torrents = magnets.map((magnetLink) => {
      return {
        title: decode(magnetLink).name,
        originalName: details.find('h1.entry-title').text(),
        year: details.find('b:contains(\'Lançamento:\')')[0]
            ? details.find('b:contains(\'Lançamento:\')')[0].nextSibling.nodeValue.trim()
            : '',
        infoHash: decode(magnetLink).infoHash,
        magnetLink: magnetLink,
        category: details.find('b:contains(\'Tipo:\')').next().attr('href').split('/')[4],
        uploadDate: new Date($("time[itemprop=dateModified]").attr("datetime")),
      };
    })
    resolve(torrents);
  });
}

module.exports = { torrent, search, browse, Categories };