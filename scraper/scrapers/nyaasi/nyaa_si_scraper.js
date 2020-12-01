const moment = require('moment');
const Bottleneck = require('bottleneck');
const nyaasi = require('./nyaa_si_api');
const { Type } = require('../../lib/types');
const Promises = require('../../lib/promises');
const repository = require('../../lib/repository');
const { createTorrentEntry, checkAndUpdateTorrent } = require('../../lib/torrentEntries');

const NAME = 'NyaaSi';
const UNTIL_PAGE = 5

const limiter = new Bottleneck({ maxConcurrent: 10 });

async function scrape() {
  const scrapeStart = moment();
  const lastScrape = await repository.getProvider({ name: NAME });
  console.log(`[${scrapeStart}] starting ${NAME} scrape...`);

  // const ids = ['1292786'];
  // return Promise.all(ids.map(id => limiter.schedule(() => nyaasi.torrent(id)
  //     .then(torrent => processTorrentRecord(torrent)))))
  //     .then(() => console.log(`[${moment()}] finished ${NAME} scrape`));
  return scrapeLatestTorrents()
      .then(() => {
        lastScrape.lastScraped = scrapeStart;
        return lastScrape.save();
      })
      .then(() => console.log(`[${moment()}] finished ${NAME} scrape`));
}

async function updateSeeders(torrent) {
  return limiter.schedule(() => nyaasi.torrent(torrent.torrentId))
      .then(foundTorrent => {
        if (Number.isInteger(foundTorrent.seeders)) {
          return [foundTorrent];
        }
        return []
      });
}

async function scrapeLatestTorrents() {
  const allowedCategories = [
    nyaasi.Categories.ANIME.ENGLISH
  ];

  return Promises.sequence(allowedCategories.map(category => () => scrapeLatestTorrentsForCategory(category)))
      .then(entries => entries.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrentsForCategory(category, page = 1) {
  console.log(`Scrapping ${NAME} ${category} category page ${page}`);
  return nyaasi.browse(({ page }))
      .catch(error => {
        console.warn(`Failed ${NAME} scrapping for [${page}] ${category} due: `, error);
        return Promise.resolve([]);
      })
      .then(torrents => Promise.all(torrents.map(torrent => limiter.schedule(() => processTorrentRecord(torrent)
          .catch(error => {
            console.warn(`Failed processing [${torrent.infoHash}] ${torrent.title} due: `, error);
            return Promise.resolve();
          })))))
      .then(resolved => resolved.length > 0 && page < UNTIL_PAGE
          ? scrapeLatestTorrentsForCategory(category, page + 1)
          : Promise.resolve());
}

async function processTorrentRecord(record) {
  if (!record || await checkAndUpdateTorrent(record)) {
    return record;
  }

  const torrent = {
    infoHash: record.infoHash,
    torrentLink: record.torrentLink,
    provider: NAME,
    torrentId: record.torrentId,
    title: record.title,
    type: Type.ANIME,
    size: record.size,
    seeders: record.seeders,
    uploadDate: record.uploadDate,
  };

  return createTorrentEntry(torrent).then(() => torrent);
}

module.exports = { scrape, updateSeeders, NAME };