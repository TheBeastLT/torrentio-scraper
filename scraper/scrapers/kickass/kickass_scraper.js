const moment = require('moment');
const Bottleneck = require('bottleneck');
const kickass = require('./kickass_api');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const Promises = require('../../lib/promises');
const { createTorrentEntry, checkAndUpdateTorrent } = require('../../lib/torrentEntries');

const NAME = 'KickassTorrents';
const UNTIL_PAGE = 10;
const TYPE_MAPPING = typeMapping();

const limiter = new Bottleneck({ maxConcurrent: 10 });

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
  return limiter.schedule(() => kickass.torrent(torrent.torrentId));
}

async function scrapeLatestTorrents() {
  const allowedCategories = [
    kickass.Categories.MOVIE,
    kickass.Categories.TV,
    kickass.Categories.ANIME,
  ];

  return Promises.sequence(allowedCategories.map(category => () => scrapeLatestTorrentsForCategory(category)))
      .then(entries => entries.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrentsForCategory(category, page = 1) {
  console.log(`Scrapping ${NAME} ${category} category page ${page}`);
  return kickass.browse(({ category, page }))
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

  const torrentFound = await kickass.torrent(record.torrentId).catch(() => undefined);

  if (!torrentFound || !TYPE_MAPPING[torrentFound.category]) {
    return Promise.resolve('Invalid torrent record');
  }

  const torrent = {
    infoHash: torrentFound.infoHash,
    provider: NAME,
    torrentId: torrentFound.torrentId,
    title: torrentFound.name.replace(/\t|\s+/g, ' '),
    type: TYPE_MAPPING[torrentFound.category],
    size: torrentFound.size,
    seeders: torrentFound.seeders,
    uploadDate: torrentFound.uploadDate,
    imdbId: torrentFound.imdbId,
    languages: torrentFound.languages || undefined
  };

  return createTorrentEntry(torrent).then(() => torrent);
}

function typeMapping() {
  const mapping = {};
  mapping[kickass.Categories.MOVIE] = Type.MOVIE;
  mapping[kickass.Categories.TV] = Type.SERIES;
  mapping[kickass.Categories.ANIME] = Type.ANIME;
  return mapping;
}

module.exports = { scrape, updateSeeders, NAME };