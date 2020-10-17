const moment = require('moment');
const Bottleneck = require('bottleneck');
const pantsu = require('./nyaa_pantsu_api');
const { Type } = require('../../lib/types');
const Promises = require('../../lib/promises');
const repository = require('../../lib/repository');
const { updateCurrentSeeders, updateTorrentSize } = require('../../lib/torrent');
const { createTorrentEntry, checkAndUpdateTorrent } = require('../../lib/torrentEntries');

const NAME = 'NyaaPantsu';
const UNTIL_PAGE = 5

const limiter = new Bottleneck({ maxConcurrent: 5 });

async function scrape() {
  const scrapeStart = moment();
  const lastScrape = await repository.getProvider({ name: NAME });
  console.log(`[${scrapeStart}] starting ${NAME} scrape...`);

  // const ids = ['1033095'];
  // return Promise.all(ids.map(id => limiter.schedule(() => pantsu.torrent(id)
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
  return limiter.schedule(() => pantsu.torrent(torrent.torrentId))
      .then(foundTorrent => {
        if (Number.isInteger(foundTorrent.seeders)) {
          return [foundTorrent];
        }
        return []
      });
}

async function scrapeLatestTorrents() {
  const allowedCategories = [
    pantsu.Categories.ANIME.ENGLISH
  ];

  return Promises.sequence(allowedCategories.map(category => () => scrapeLatestTorrentsForCategory(category)))
      .then(entries => entries.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrentsForCategory(category, page = 1) {
  console.log(`Scrapping ${NAME} ${category} category page ${page}`);
  return pantsu.browse(({ page }))
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

  if (!record.size) {
    await updateTorrentSize(record)
  }
  if (record.seeders === null || record.seeders === undefined) {
    await updateCurrentSeeders(record);
  }

  const torrent = {
    infoHash: record.infoHash,
    provider: NAME,
    torrentId: record.torrentId,
    title: record.title,
    type: Type.ANIME,
    size: record.size,
    seeders: record.seeders,
    uploadDate: record.uploadDate,
    languages: record.languages,
    files: record.files || undefined
  };

  return createTorrentEntry(torrent).then(() => torrent);
}

module.exports = { scrape, updateSeeders, NAME };