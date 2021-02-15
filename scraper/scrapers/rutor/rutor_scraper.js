const moment = require('moment');
const Bottleneck = require('bottleneck');
const rutor = require('./rutor_api');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const Promises = require('../../lib/promises');
const { createTorrentEntry, checkAndUpdateTorrent } = require('../../lib/torrentEntries');

const NAME = 'Rutor';
const TYPE_MAPPING = {
  'kino': Type.MOVIE,
  'nashe_kino': Type.MOVIE,
  'nauchno_popularnoe': Type.MOVIE,
  'inostrannoe': Type.MOVIE,
  'seriali': Type.SERIES,
  'nashi_seriali': Type.SERIES,
  'tv': Type.SERIES,
  'multiki': Type.MOVIE,
  'anime': Type.ANIME
}
const ALLOWED_WITHOUT_IMDB = ['kino', 'seriali', 'anime'];

const api_limiter = new Bottleneck({ maxConcurrent: 1, minTime: 5000 });
const api_entry_limiter = new Bottleneck({ maxConcurrent: 1, minTime: 2500 });
const limiter = new Bottleneck({ maxConcurrent: 10 });
const allowedCategories = [
  rutor.Categories.FOREIGN_FILMS,
  rutor.Categories.FOREIGN_RELEASES,
  rutor.Categories.RUSSIAN_FILMS,
  rutor.Categories.FOREIGN_SERIES,
  rutor.Categories.RUSSIAN_SERIES,
  rutor.Categories.SCIENCE_FILMS,
  rutor.Categories.RUSSIAN_ANIMATION,
  rutor.Categories.ANIME
];

async function scrape() {
  const scrapeStart = moment();
  const lastScrape = await repository.getProvider({ name: NAME });
  console.log(`[${scrapeStart}] starting ${NAME} scrape...`);

  // const ids = [
  //   '637799'
  // ];
  // return Promise.all(ids.map(id => api_entry_limiter.schedule(() => rutor.torrent(id))
  //     .then(torrent => processTorrentRecord(torrent))))
  //     .then(() => console.log(`[${moment()}] finished ${NAME} scrape`));
  return scrapeLatestTorrents()
      .then(() => {
        lastScrape.lastScraped = scrapeStart;
        return lastScrape.save();
      })
      .then(() => console.log(`[${moment()}] finished ${NAME} scrape`));
}

async function updateSeeders(torrent) {
  return Promise.resolve([]);
}

async function scrapeLatestTorrents() {
  return Promises.sequence(allowedCategories.map(category => () => scrapeLatestTorrentsForCategory(category)))
      .then(entries => entries.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrentsForCategory(category, page = 185) {
  console.log(`Scrapping ${NAME} ${category} category page ${page}`);
  return api_limiter.schedule(() => rutor.browse({ category, page }))
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
  if (await checkAndUpdateTorrent(record)) {
    return record;
  }
  const isOld = moment(record.uploadDate).isBefore(moment().subtract(18, 'month'));
  if (record.seeders === 0 && isOld) {
    console.log(`Skipping old unseeded torrent [${record.infoHash}] ${record.title}`)
    return record;
  }

  const foundTorrent = await api_entry_limiter.schedule(() => rutor.torrent(record.torrentId).catch(() => undefined));

  if (!foundTorrent || !TYPE_MAPPING[foundTorrent.category]) {
    return Promise.resolve(`${NAME}: Invalid torrent record: ${record.torrentId}`);
  }
  if (!foundTorrent.imdbId && !ALLOWED_WITHOUT_IMDB.includes(foundTorrent.category)) {
    return Promise.resolve(`${NAME}: No imdbId defined: ${record.torrentId}`);
  }

  const torrent = {
    provider: NAME,
    infoHash: foundTorrent.infoHash,
    torrentId: foundTorrent.torrentId,
    torrentLink: foundTorrent.torrentLink,
    trackers: foundTorrent.trackers,
    title: foundTorrent.title,
    type: TYPE_MAPPING[foundTorrent.category],
    size: foundTorrent.size,
    seeders: foundTorrent.seeders,
    uploadDate: foundTorrent.uploadDate,
    imdbId: foundTorrent.imdbId,
    languages: foundTorrent.languages || undefined,
  };

  return createTorrentEntry(torrent).then(() => torrent);
}

function getMaxPage(category) {
  switch (category) {
    case rutor.Categories.FOREIGN_FILMS:
    case rutor.Categories.FOREIGN_SERIES:
      return 2;
    default:
      return 1;
  }
}

module.exports = { scrape, updateSeeders, NAME };