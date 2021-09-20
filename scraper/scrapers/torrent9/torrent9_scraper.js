const moment = require('moment');
const Bottleneck = require('bottleneck');
const torrent9 = require('./torrent9_api');
const torrent9v2 = require('./torrent9v2_api');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const Promises = require('../../lib/promises');
const { createTorrentEntry, checkAndUpdateTorrent } = require('../../lib/torrentEntries');
const { Op } = require("sequelize");

const NAME = 'Torrent9';
const TYPE_MAPPING = typeMapping();

const api_limiter = new Bottleneck({ maxConcurrent: 1, minTime: 5000 });
const limiter = new Bottleneck({ maxConcurrent: 10 });
const allowedCategories = [
  torrent9.Categories.MOVIE,
  torrent9.Categories.TV,
];
const clients = [
  torrent9,
  torrent9v2
];

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

async function scrapeLatestTorrents() {
  const scrapeFunctions = allowedCategories
      .map(category => clients.map(client => () => scrapeLatestTorrentsForCategory(client, category)))
      .reduce((a, b) => a.concat(b), []);
  return Promises.sequence(scrapeFunctions)
      .then(entries => entries.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrentsForCategory(client, category, page = 1) {
  console.log(`Scrapping ${NAME} ${category} category page ${page}`);
  return api_limiter.schedule(() => client.browse({ category, page }))
      .catch(error => {
        console.warn(`Failed ${NAME} scrapping for [${page}] ${category} due: `, error);
        return Promise.resolve([]);
      })
      .then(results => Promise.all(results.map(r => limiter.schedule(() => processTorrentRecord(client, r)))))
      .then(resolved => resolved.length > 0 && page < getUntilPage(category)
          ? scrapeLatestTorrentsForCategory(client, category, page + 1)
          : Promise.resolve([]));
}

async function processTorrentRecord(client, record) {
  if (await checkAndUpdateTorrent(
      { provider: NAME, torrentId: { [Op.endsWith]: record.torrentId.replace(/^\d+/, '') } })) {
    return record;
  }

  const foundTorrent = await api_limiter.schedule(() => client.torrent(record.torrentId)).catch(() => undefined);
  if (!foundTorrent) {
    console.warn(`Failed retrieving torrent ${record.torrentId}`);
    return record;
  }

  const torrent = {
    provider: NAME,
    infoHash: foundTorrent.infoHash,
    magnetLink: foundTorrent.magnetLink,
    torrentLink: foundTorrent.torrentLink,
    torrentId: foundTorrent.torrentId,
    title: foundTorrent.title,
    type: TYPE_MAPPING[foundTorrent.category],
    size: foundTorrent.size,
    seeders: foundTorrent.seeders,
    uploadDate: foundTorrent.uploadDate,
    imdbId: foundTorrent.imdbId,
    languages: foundTorrent.languages
  };

  if (await checkAndUpdateTorrent(torrent)) {
    console.info(`Skipping torrent ${torrent.torrentId} - [${torrent.infoHash}] ${torrent.title}`);
    return torrent;
  }

  return createTorrentEntry(torrent).then(() => torrent);
}

function typeMapping() {
  const mapping = {};
  mapping[torrent9.Categories.MOVIE] = Type.MOVIE;
  mapping[torrent9.Categories.TV] = Type.SERIES;
  return mapping;
}

function getUntilPage(category) {
  if (category === torrent9.Categories.TV) {
    return 2;
  }
  return 1;
}

module.exports = { scrape, NAME };