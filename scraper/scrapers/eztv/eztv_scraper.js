const moment = require('moment');
const Bottleneck = require('bottleneck');
const { parse } = require('parse-torrent-title');
const eztv = require('./eztv_api');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const { createTorrentEntry, checkAndUpdateTorrent } = require('../../lib/torrentEntries');

const NAME = 'EZTV';
const UNTIL_PAGE = 10;

const limiter = new Bottleneck({ maxConcurrent: 1 });
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
  //     .then(imdbIds => Promise.all(imdbIds.map(imdbId => limiter.schedule(() => eztv.search(imdbId)))))
  //     .then(results => results.reduce((a, b) => a.concat(b), []))
  //     .catch(() => limiter.schedule(() => eztv.torrent(torrent.torrentId)));
  return limiter.schedule(() => eztv.torrent(torrent.torrentId));
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
      .then(torrents => Promise.all(torrents.map(t => entryLimiter.schedule(() => processTorrentRecord(t)))))
      .then(resolved => resolved.length > 0 && page < UNTIL_PAGE
          ? scrapeLatestTorrentsForCategory(page + 1)
          : Promise.resolve());
}

async function processTorrentRecord(record) {
  if (await checkAndUpdateTorrent(record)) {
    return record;
  }

  if (!record || !record.size) {
    return Promise.resolve('Invalid torrent record');
  }

  // imdb id for talk shows is usually incorrect on eztv
  const parsedTitle = parse(record.name);
  const dateEpisode = !parsedTitle.season && parsedTitle.date;

  const torrent = {
    infoHash: record.infoHash,
    provider: NAME,
    torrentId: record.torrentId,
    title: record.name.replace(/\t|\s+/g, ' ').trim(),
    type: Type.SERIES,
    size: record.size,
    seeders: record.seeders,
    uploadDate: record.uploadDate,
    imdbId: !dateEpisode && record.imdbId,
  };

  return createTorrentEntry(torrent).then(() => torrent);
}

module.exports = { scrape, updateSeeders, NAME };