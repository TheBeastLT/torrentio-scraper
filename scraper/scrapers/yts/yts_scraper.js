const moment = require('moment');
const Bottleneck = require('bottleneck');
const yts = require('./yts_api');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const { createTorrentEntry, getStoredTorrentEntry, updateTorrentSeeders } = require('../../lib/torrentEntries');

const NAME = 'YTS';
const UNTIL_PAGE = 2;

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
  return limiter.schedule(() => yts.torrent(torrent.torrentId));
}

async function scrapeLatestTorrents() {
  return scrapeLatestTorrentsForCategory();
}

async function scrapeLatestTorrentsForCategory(page = 1) {
  console.log(`Scrapping ${NAME} page ${page}`);
  return yts.browse(({ page }))
      .catch(error => {
        console.warn(`Failed ${NAME} scrapping for [${page}] due: `, error);
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
    type: Type.MOVIE,
    size: record.size,
    seeders: record.seeders,
    uploadDate: record.uploadDate,
    imdbId: record.imdbId,
  };

  return createTorrentEntry(torrent).then(() => torrent);
}

module.exports = { scrape, updateSeeders, NAME };