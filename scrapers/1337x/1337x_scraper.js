const moment = require('moment');
const Bottleneck = require('bottleneck');
const leetx = require('./1337x_api');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const { createTorrentEntry, createSkipTorrentEntry, getStoredTorrentEntry } = require('../../lib/torrentEntries');

const NAME = '1337x';
const UNTIL_PAGE = 1;
const TYPE_MAPPING = {
  'Movies': Type.MOVIE,
  'Documentaries': Type.MOVIE,
  'TV': Type.SERIES,
  'Anime': Type.ANIME
};

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
        return lastScrape.save();
      });
}

async function getLatestTorrents() {
  const movies = await getLatestTorrentsForCategory(leetx.Categories.MOVIE);
  const series = await getLatestTorrentsForCategory(leetx.Categories.TV);
  const anime = await getLatestTorrentsForCategory(leetx.Categories.ANIME);
  const docs = await getLatestTorrentsForCategory(leetx.Categories.DOCUMENTARIES);
  return movies.concat(series).concat(anime).concat(docs);
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
    return;
  }

  const torrentFound = await leetx.torrent(record.slug).catch(() => undefined);

  if (!torrentFound || !TYPE_MAPPING[torrentFound.category]) {
    return createSkipTorrentEntry(record);
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

module.exports = { scrape };