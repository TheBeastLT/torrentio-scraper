const moment = require('moment');
const Bottleneck = require('bottleneck');
const eztv = require('./eztv_api');
const { Type } = require('../../lib/types');
const Promises = require('../../lib/promises');
const repository = require('../../lib/repository');

const { updateCurrentSeeders } = require('../../lib/torrent');
const { createTorrentEntry, getStoredTorrentEntry, updateTorrentSeeders } = require('../../lib/torrentEntries');

const NAME = 'EZTV';
const UNTIL_PAGE = 10;

const limiter = new Bottleneck({ maxConcurrent: 20 });

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
  return limiter.schedule(() => eztv.torrent(torrent.torrentId)
      .then(record => (torrent.seeders = record.seeders, torrent))
      .catch(() => updateCurrentSeeders(torrent))
      .then(updated => updateTorrentSeeders(updated)));
}

async function scrapeLatestTorrents() {
  return scrapeLatestTorrentsForCategory();
}

async function scrapeLatestTorrentsForCategory(page = 1) {
  console.log(`Scrapping ${NAME} page ${page}`);
  return eztv.browse(({ page }))
      .catch(error => {
        console.warn(`Failed ${NAME} scrapping for [${page}] due: `, error);
        // return Promises.delay(30000).then(() => scrapeLatestTorrentsForCategory(page))
        return Promise.resolve([]);
      })
      .then(torrents => Promise.all(torrents.map(torrent => limiter.schedule(() => processTorrentRecord(torrent)))))
      .then(resolved => resolved.length > 0 && page < UNTIL_PAGE
          ? scrapeLatestTorrentsForCategory(page + 1)
          : Promise.resolve());
}

async function processTorrentRecord(record) {
  if (await getStoredTorrentEntry(record)) {
    return updateTorrentSeeders(record);
  }

  if (!record || !record.size) {
    return Promise.resolve('Invalid torrent record');
  }

  const torrent = {
    infoHash: record.infoHash,
    provider: NAME,
    torrentId: record.torrentId,
    title: record.name.replace(/\t|\s+/g, ' ').trim(),
    type: Type.SERIES,
    size: record.size,
    seeders: record.seeders,
    uploadDate: record.uploadDate,
    imdbId: record.imdbId,
  };

  return createTorrentEntry(torrent).then(() => torrent);
}

module.exports = { scrape, updateSeeders, NAME };