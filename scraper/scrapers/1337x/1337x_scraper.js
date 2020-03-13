const moment = require('moment');
const Bottleneck = require('bottleneck');
const leetx = require('./1337x_api');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const {
  createTorrentEntry,
  createSkipTorrentEntry,
  getStoredTorrentEntry,
  updateTorrentSeeders
} = require('../../lib/torrentEntries');

const NAME = '1337x';
const UNTIL_PAGE = 1;
const TYPE_MAPPING = typeMapping();

const limiter = new Bottleneck({ maxConcurrent: 40 });

async function scrape() {
  const scrapeStart = moment();
  const lastScrape = await repository.getProvider({ name: NAME });
  console.log(`[${scrapeStart}] starting ${NAME} scrape...`);

  const latestTorrents = await getLatestTorrents();
  return Promise.all(latestTorrents.map(torrent => limiter.schedule(() => processTorrentRecord(torrent))))
      .then(() => {
        lastScrape.lastScraped = scrapeStart;
        lastScrape.lastScrapedId = latestTorrents.length && latestTorrents[latestTorrents.length - 1].torrentId;
        return repository.updateProvider(lastScrape);
      })
      .then(() => console.log(`[${moment()}] finished ${NAME} scrape`));
}

async function getLatestTorrents() {
  const allowedCategories = [
    leetx.Categories.MOVIE,
    leetx.Categories.TV,
    leetx.Categories.ANIME,
    leetx.Categories.DOCUMENTARIES
  ];

  return Promise.all(allowedCategories.map(category => getLatestTorrentsForCategory(category)))
      .then(entries => entries.reduce((a, b) => a.concat(b), []));
}

async function getLatestTorrentsForCategory(category, page = 1) {
  return leetx.browse(({ category: category, page: page }))
      .then(torrents => torrents.length && page < UNTIL_PAGE
          ? getLatestTorrents(category, page + 1).then(nextTorrents => torrents.concat(nextTorrents))
          : torrents)
      .catch(() => []);
}

async function processTorrentRecord(record) {
  if (await getStoredTorrentEntry(record)) {
    return updateTorrentSeeders(record);
  }

  const torrentFound = await leetx.torrent(record.torrentId).catch(() => undefined);

  if (!torrentFound || !TYPE_MAPPING[torrentFound.category]) {
    return createSkipTorrentEntry(record);
  }
  if (isNaN(torrentFound.uploadDate)) {
    console.warn(`Incorrect upload date for [${torrentFound.infoHash}] ${torrentFound.name}`);
    return;
  }

  const torrent = {
    infoHash: torrentFound.infoHash,
    provider: NAME,
    torrentId: torrentFound.torrentId,
    title: torrentFound.name.replace(/\t|\s+/g, ' '),
    seeders: torrentFound.seeders,
    size: torrentFound.size,
    type: TYPE_MAPPING[torrentFound.category],
    uploadDate: torrentFound.uploadDate,
    imdbId: torrentFound.imdbId,
  };

  return createTorrentEntry(torrent);
}

function typeMapping() {
  const mapping = {};
  mapping[leetx.Categories.MOVIE] = Type.MOVIE;
  mapping[leetx.Categories.DOCUMENTARIES] = Type.MOVIE;
  mapping[leetx.Categories.TV] = Type.SERIES;
  mapping[leetx.Categories.ANIME] = Type.ANIME;
  return mapping;
}

module.exports = { scrape, NAME };