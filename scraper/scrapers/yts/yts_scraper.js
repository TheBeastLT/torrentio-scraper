const moment = require('moment');
const Bottleneck = require('bottleneck');
const yts = require('./yts_api');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const { createTorrentEntry, checkAndUpdateTorrent } = require('../../lib/torrentEntries');

const NAME = 'YTS';
const UNTIL_PAGE = 10;

const limiter = new Bottleneck({ maxConcurrent: 10 });

async function scrape(maxPage) {
  const scrapeStart = moment();
  const lastScrape = await repository.getProvider({ name: NAME });
  console.log(`[${scrapeStart}] starting ${NAME} scrape...`);

  return scrapeLatestTorrentsForCategory(maxPage)
      .then(() => {
        lastScrape.lastScraped = scrapeStart;
        return lastScrape.save();
      })
      .then(() => console.log(`[${moment()}] finished ${NAME} scrape`));
}

async function updateSeeders(torrent) {
  return limiter.schedule(() => yts.torrent(torrent.torrentId));
}

async function scrapeLatestTorrentsForCategory(maxPage = UNTIL_PAGE, page = 1) {
  console.log(`Scrapping ${NAME} page ${page}`);
  return yts.browse(({ page }))
      .catch(error => {
        console.warn(`Failed ${NAME} scrapping for [${page}] due: `, error);
        return Promise.resolve([]);
      })
      .then(torrents => Promise.all(torrents.map(torrent => limiter.schedule(() => processTorrentRecord(torrent)))))
      .then(resolved => resolved.length > 0 && page < maxPage
          ? scrapeLatestTorrentsForCategory(maxPage, page + 1)
          : Promise.resolve());
}

async function processTorrentRecord(record) {
  if (await checkAndUpdateTorrent(record)) {
    return record;
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