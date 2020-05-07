const moment = require('moment');
const Bottleneck = require('bottleneck');
const rarbg = require('rarbg-api');
const decode = require('magnet-uri');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const Promises = require('../../lib/promises');
const { createTorrentEntry, checkAndUpdateTorrent } = require('../../lib/torrentEntries');

const NAME = 'RARBG';
const SEARCH_OPTIONS = { limit: 100, sort: 'seeders', format: 'json_extended', ranked: 0 };

const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 2500 });
const entryLimiter = new Bottleneck({ maxConcurrent: 10 });

async function scrape() {
  const scrapeStart = moment();
  const lastScrape = await repository.getProvider({ name: NAME });
  console.log(`[${scrapeStart}] starting ${NAME} scrape...`);

  return scrapeLatestTorrents()
      .then(() => {
        lastScrape.lastScraped = scrapeStart;
        return lastScrape.save();
      })
      .then(() => console.log(`[${moment()}] finished ${NAME} scrape`));
}

async function updateSeeders(torrent, getImdbIdsMethod) {
  return getImdbIdsMethod()
      .then(imdbIds => Promise.all(imdbIds.map(imdbId => limiter.schedule(() => search(imdbId)))))
      .then(results => results.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrents() {
  const allowedCategories = [
    rarbg.CATEGORY['4K_MOVIES_X264_4k'],
    rarbg.CATEGORY['4K_X265_4k'],
    rarbg.CATEGORY['4k_X264_4k_HDR'],
    rarbg.CATEGORY.MOVIES_XVID,
    rarbg.CATEGORY.MOVIES_XVID_720P,
    [54], // Movies/x265/1080
    rarbg.CATEGORY.MOVIES_X264,
    rarbg.CATEGORY.MOVIES_X264_1080P,
    rarbg.CATEGORY.MOVIES_X264_720P,
    rarbg.CATEGORY.MOVIES_X264_3D,
    rarbg.CATEGORY.MOVIES_BD_REMUX,
    rarbg.CATEGORY.TV_EPISODES,
    rarbg.CATEGORY.TV_UHD_EPISODES,
    rarbg.CATEGORY.TV_HD_EPISODES
  ];

  return Promises.sequence(allowedCategories
      .map(category => () => limiter.schedule(() => scrapeLatestTorrentsForCategory(category))))
      .then(entries => entries.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrentsForCategory(category, retries = 5) {
  console.log(`Scrapping ${NAME} ${category} category`);
  return rarbg.list({ category: category, limit: 100, sort: 'last', format: 'json_extended', ranked: 0 })
      .then(results => results.map(result => toTorrent(result)))
      .then(torrents => Promise.all(torrents.map(t => entryLimiter.schedule(() => processTorrentRecord(t)))))
      .catch(error => {
        if (retries > 0) {
          console.log(`Retrying ${NAME} request for ${category}...`);
          return scrapeLatestTorrentsForCategory(category, retries - 1);
        }
        console.warn(`Failed ${NAME} scrapping for ${category} due: `, error);
        return Promise.resolve([]);
      });
}

async function processTorrentRecord(record) {
  if (await checkAndUpdateTorrent(record)) {
    return record;
  }

  const torrent = {
    provider: NAME,
    infoHash: record.infoHash,
    title: record.title,
    type: getType(record.category),
    seeders: record.seeders,
    size: record.size,
    uploadDate: record.uploadDate,
    imdbId: record.imdbId
  };

  return createTorrentEntry(torrent);
}

async function search(imdbId, retries = 5) {
  return rarbg.search(imdbId, SEARCH_OPTIONS, 'imdb')
      .then(results => results.map(result => toTorrent(result)))
      .catch(error => {
        if (retries > 0) {
          console.log(`Retrying ${imdbId} search...`);
          return search(imdbId, retries - 1);
        }
        return Promise.reject(error);
      });
}

function toTorrent(result) {
  return {
    title: result.title,
    provider: NAME,
    infoHash: decode(result.download).infoHash,
    magnetLink: result.download,
    seeders: result.seeders,
    leechers: result.leechers,
    category: result.category,
    size: result.size,
    uploadDate: new Date(result.pubdate),
    imdbId: result.episode_info && result.episode_info.imdb
  };
}

const seriesCategories = [
  'TV Episodes',
  'Movies/TV-UHD-episodes',
  'TV HD Episodes',
];

function getType(category) {
  if (seriesCategories.includes(category)) {
    return Type.SERIES;
  }
  return Type.MOVIE;
}

module.exports = { scrape, updateSeeders, NAME };