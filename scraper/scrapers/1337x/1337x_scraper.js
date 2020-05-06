const moment = require('moment');
const Bottleneck = require('bottleneck');
const leetx = require('./1337x_api');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const Promises = require('../../lib/promises');
const { createTorrentEntry, checkAndUpdateTorrent } = require('../../lib/torrentEntries');

const NAME = '1337x';
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
  return limiter.schedule(() => leetx.torrent(torrent.torrentId));
}

async function scrapeLatestTorrents() {
  const allowedCategories = [
    leetx.Categories.MOVIE,
    leetx.Categories.TV,
    leetx.Categories.ANIME,
    leetx.Categories.DOCUMENTARIES
  ];

  return Promises.sequence(allowedCategories.map(category => () => scrapeLatestTorrentsForCategory(category)))
      .then(entries => entries.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrentsForCategory(category, page = 1) {
  console.log(`Scrapping ${NAME} ${category} category page ${page}`);
  return leetx.browse(({ category, page }))
      .catch(error => {
        console.warn(`Failed ${NAME} scrapping for [${page}] ${category} due: `, error);
        return Promise.resolve([]);
      })
      .then(torrents => Promise.all(torrents.map(torrent => limiter.schedule(() => processTorrentRecord(torrent)))))
      .then(resolved => resolved.length > 0 && page < untilPage(category)
          ? scrapeLatestTorrentsForCategory(category, page + 1)
          : Promise.resolve());

}

async function processTorrentRecord(record) {
  const torrentFound = await leetx.torrent(record.torrentId).catch(() => undefined);

  if (!torrentFound || !TYPE_MAPPING[torrentFound.category]) {
    return Promise.resolve('Invalid torrent record');
  }
  if (isNaN(torrentFound.uploadDate)) {
    console.warn(`Incorrect upload date for [${torrentFound.infoHash}] ${torrentFound.name}`);
    return;
  }
  if (await checkAndUpdateTorrent(torrentFound)) {
    return torrentFound;
  }

  const torrent = {
    infoHash: torrentFound.infoHash,
    provider: NAME,
    torrentId: torrentFound.torrentId,
    title: torrentFound.name.replace(/\t|\s+/g, ' ').trim(),
    type: TYPE_MAPPING[torrentFound.category],
    size: torrentFound.size,
    seeders: torrentFound.seeders,
    uploadDate: torrentFound.uploadDate,
    imdbId: torrentFound.imdbId,
    languages: torrentFound.languages || undefined
  };

  return createTorrentEntry(torrent);
}

function typeMapping() {
  const mapping = {};
  mapping[leetx.Categories.MOVIE] = Type.MOVIE;
  mapping[leetx.Categories.DOCUMENTARIES] = Type.SERIES;
  mapping[leetx.Categories.TV] = Type.SERIES;
  mapping[leetx.Categories.ANIME] = Type.ANIME;
  return mapping;
}

function untilPage(category) {
  if (leetx.Categories.ANIME === category) {
    return 5;
  }
  if (leetx.Categories.DOCUMENTARIES === category) {
    return 1;
  }
  return UNTIL_PAGE;
}

module.exports = { scrape, updateSeeders, NAME };