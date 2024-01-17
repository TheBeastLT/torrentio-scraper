const moment = require('moment');
const Bottleneck = require('bottleneck');
const rarbg = require('./rarbg_api');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const Promises = require('../../lib/promises');
const { createTorrentEntry, checkAndUpdateTorrent } = require('../../lib/torrentEntries');

const NAME = 'RARBG';

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
  // return getImdbIdsMethod()
  //     .then(imdbIds => Promise.all(imdbIds.map(imdbId => limiter.schedule(() => search(imdbId)))))
  //     .then(results => results.reduce((a, b) => a.concat(b), []));
  return Promise.resolve([]);
}

async function scrapeLatestTorrents() {
  const allowedCategories = [
    rarbg.Options.category.MOVIES_XVID,
    rarbg.Options.category.MOVIES_XVID_720P,
    rarbg.Options.category.MOVIES_X265_1080P,
    rarbg.Options.category.MOVIES_X264,
    rarbg.Options.category.MOVIES_X264_720P,
    rarbg.Options.category.MOVIES_X264_1080P,
    rarbg.Options.category.MOVIES_HIGH_RES,
    rarbg.Options.category.TV_EPISODES,
    rarbg.Options.category.TV_UHD_EPISODES,
    rarbg.Options.category.TV_HD_EPISODES
  ];

  return Promises.sequence(allowedCategories
          .map(category => () => limiter.schedule(() => scrapeLatestTorrentsForCategory(category))))
      .then(entries => entries.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrentsForCategory(category) {
  console.log(`Scrapping ${NAME} ${category} category`);
  return rarbg.browse({ category: category })
      .then(torrents => Promise.all(torrents.map(t => entryLimiter.schedule(() => processTorrentRecord(t)))))
      .catch(error => {
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