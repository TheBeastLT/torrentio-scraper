const moment = require('moment');
const Bottleneck = require('bottleneck');
const torrentGalaxy = require('./torrentgalaxy_api');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const Promises = require('../../lib/promises');
const { createTorrentEntry, checkAndUpdateTorrent } = require('../../lib/torrentEntries');

const NAME = 'TorrentGalaxy';
const TYPE_MAPPING = typeMapping();

const limiter = new Bottleneck({ maxConcurrent: 10 });
const allowedCategories = [
  torrentGalaxy.Categories.ANIME,
  torrentGalaxy.Categories.MOVIE_4K,
  torrentGalaxy.Categories.MOVIE_PACKS,
  torrentGalaxy.Categories.MOVIE_SD,
  torrentGalaxy.Categories.MOVIE_HD,
  torrentGalaxy.Categories.MOVIE_CAM,
  torrentGalaxy.Categories.MOVIE_BOLLYWOOD,
  torrentGalaxy.Categories.TV_SD,
  torrentGalaxy.Categories.TV_HD,
  torrentGalaxy.Categories.TV_PACKS,
  torrentGalaxy.Categories.TV_SPORT,
  torrentGalaxy.Categories.DOCUMENTARIES,
];
const packCategories = [
  torrentGalaxy.Categories.MOVIE_PACKS,
  torrentGalaxy.Categories.TV_PACKS
];

async function scrape() {
  const scrapeStart = moment();
  const lastScrape = await repository.getProvider({ name: NAME });
  console.log(`[${scrapeStart}] starting ${NAME} scrape...`);

  // const ids = ['14212584'];
  // return Promise.all(ids.map(id => limiter.schedule(() => torrentGalaxy.torrent(id)
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
  return limiter.schedule(() => torrentGalaxy.torrent(torrent.torrentId));
}

async function scrapeLatestTorrents() {
  return Promises.sequence(allowedCategories.map(category => () => scrapeLatestTorrentsForCategory(category)))
      .then(entries => entries.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrentsForCategory(category, page = 1) {
  console.log(`Scrapping ${NAME} ${category} category page ${page}`);
  return torrentGalaxy.browse(({ category, page }))
      .catch(error => {
        console.warn(`Failed ${NAME} scrapping for [${page}] ${category} due: `, error);
        return Promise.resolve([]);
      })
      .then(torrents => Promise.all(torrents.map(torrent => limiter.schedule(() => processTorrentRecord(torrent)))))
      .then(resolved => resolved.length > 0 && page < getMaxPage(category)
          ? scrapeLatestTorrentsForCategory(category, page + 1)
          : Promise.resolve());
}

async function processTorrentRecord(record) {
  if (!record || !TYPE_MAPPING[record.category] || !record.verified) {
    return Promise.resolve('Invalid torrent record');
  }

  if (await checkAndUpdateTorrent(record)) {
    return record;
  }

  const torrent = {
    provider: NAME,
    infoHash: record.infoHash,
    torrentId: record.torrentId,
    torrentLink: record.torrentLink,
    title: record.name.replace(/\t|\s+/g, ' '),
    type: TYPE_MAPPING[record.category],
    size: record.size,
    seeders: record.seeders,
    uploadDate: record.uploadDate,
    imdbId: record.imdbId,
    pack: packCategories.includes(record.category),
    languages: !(record.languages || '').includes('Other') ? record.languages : undefined
  };

  return createTorrentEntry(torrent).then(() => torrent);
}

function typeMapping() {
  const mapping = {};
  mapping[torrentGalaxy.Categories.MOVIE_SD] = Type.MOVIE;
  mapping[torrentGalaxy.Categories.MOVIE_HD] = Type.MOVIE;
  mapping[torrentGalaxy.Categories.MOVIE_4K] = Type.MOVIE;
  mapping[torrentGalaxy.Categories.MOVIE_CAM] = Type.MOVIE;
  mapping[torrentGalaxy.Categories.MOVIE_PACKS] = Type.MOVIE;
  mapping[torrentGalaxy.Categories.MOVIE_BOLLYWOOD] = Type.MOVIE;
  mapping[torrentGalaxy.Categories.DOCUMENTARIES] = Type.MOVIE;
  mapping[torrentGalaxy.Categories.TV_SD] = Type.SERIES;
  mapping[torrentGalaxy.Categories.TV_HD] = Type.SERIES;
  mapping[torrentGalaxy.Categories.TV_PACKS] = Type.SERIES;
  mapping[torrentGalaxy.Categories.TV_SPORT] = Type.SERIES;
  mapping[torrentGalaxy.Categories.ANIME] = Type.ANIME;
  return mapping;
}

function getMaxPage(category) {
  switch (category) {
    case torrentGalaxy.Categories.TV_SD:
    case torrentGalaxy.Categories.TV_HD:
      return 10;
    case torrentGalaxy.Categories.MOVIE_SD:
    case torrentGalaxy.Categories.MOVIE_HD:
      return 5;
    default:
      return 1;
  }
}

module.exports = { scrape, updateSeeders, NAME };