const moment = require('moment');
const Bottleneck = require('bottleneck');
const thepiratebay = require('./thepiratebay_api.js');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const Promises = require('../../lib/promises');
const { updateCurrentSeeders } = require('../../lib/torrent');
const { createTorrentEntry, checkAndUpdateTorrent } = require('../../lib/torrentEntries');

const NAME = 'ThePirateBay';
const UNTIL_PAGE = 5;

const limiter = new Bottleneck({ maxConcurrent: 5 });

const allowedCategories = [
  thepiratebay.Categories.VIDEO.MOVIES,
  thepiratebay.Categories.VIDEO.MOVIES_HD,
  thepiratebay.Categories.VIDEO.MOVIES_3D,
  thepiratebay.Categories.VIDEO.TV_SHOWS,
  thepiratebay.Categories.VIDEO.TV_SHOWS_HD
];
const seriesCategories = [
  thepiratebay.Categories.VIDEO.TV_SHOWS,
  thepiratebay.Categories.VIDEO.TV_SHOWS_HD
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

async function updateSeeders(torrent) {
  // return limiter.schedule(() => thepiratebay.torrent(torrent.torrentId));
  return Promise.resolve([]);
}

async function scrapeLatestTorrents() {
  return Promises.sequence(allowedCategories.map(category => () => scrapeLatestTorrentsForCategory(category)))
      .then(entries => entries.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrentsForCategory(category, page = 1) {
  console.log(`Scrapping ${NAME} ${category} category page ${page}`);
  return thepiratebay.browse({ category, page })
      .catch(error => {
        console.warn(`Failed ${NAME} scrapping for [${page}] ${category} due: `, error);
        return Promise.resolve([]);
      })
      .then(torrents => Promise.all(torrents.map(torrent => limiter.schedule(() => processTorrentRecord(torrent)))))
      .then(resolved => resolved.length > 0 && page < UNTIL_PAGE
          ? scrapeLatestTorrentsForCategory(category, page + 1)
          : Promise.resolve());
}

async function processTorrentRecord(record) {
  if (await checkAndUpdateTorrent(record)) {
    return record;
  }

  if (!record || !allowedCategories.includes(record.subcategory)) {
    return Promise.resolve('Invalid torrent record');
  }
  if (record.seeders === null || record.seeders === undefined) {
    await updateCurrentSeeders(record);
  }

  const torrent = {
    infoHash: record.infoHash,
    provider: NAME,
    torrentId: record.torrentId,
    title: record.name.replace(/\t|\s+/g, ' '),
    type: seriesCategories.includes(record.subcategory) ? Type.SERIES : Type.MOVIE,
    size: record.size,
    seeders: record.seeders,
    uploadDate: record.uploadDate,
    imdbId: seriesCategories.includes(record.subcategory) && record.imdbId || undefined,
    languages: record.languages && record.languages.trim() || undefined
  };

  return createTorrentEntry(torrent);
}

module.exports = { scrape, updateSeeders, NAME };