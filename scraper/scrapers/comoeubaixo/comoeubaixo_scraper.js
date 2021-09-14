const moment = require("moment");
const Bottleneck = require("bottleneck");
const comoeubaixo = require("./comoeubaixo_api");
const { Type } = require("../../lib/types");
const repository = require("../../lib/repository");
const Promises = require("../../lib/promises");
const { createTorrentEntry, checkAndUpdateTorrent } = require("../../lib/torrentEntries");
const { updateCurrentSeeders, updateTorrentSize } = require("../../lib/torrent");

const NAME = "ComoEuBaixo";
const UNTIL_PAGE = 5;
const TYPE_MAPPING = typeMapping();

const limiter = new Bottleneck({ maxConcurrent: 5 });

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
  return limiter.schedule(() => comoeubaixo.torrent(torrent.torrentId));
}

async function scrapeLatestTorrents() {
  const allowedCategories = [
    comoeubaixo.Categories.MOVIE,
    comoeubaixo.Categories.TV,
    comoeubaixo.Categories.DESENHOS
  ];

  return Promises.sequence(allowedCategories
          .map((category) => () => scrapeLatestTorrentsForCategory(category)))
      .then((entries) => entries.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrentsForCategory(category, page = 1) {
  console.log(`Scrapping ${NAME} ${category} category page ${page}`);
  return comoeubaixo
      .browse({ category, page })
      .catch((error) => {
        console.warn(`Failed ${NAME} scrapping for [${page}] ${category} due: `, error);
        return Promise.resolve([]);
      })
      .then((torrents) => Promise.all(torrents.map((torrent) => limiter.schedule(() => processEntry(torrent)))))
      .then((resolved) => resolved.length > 0 && page < untilPage(category)
          ? scrapeLatestTorrentsForCategory(category, page + 1)
          : Promise.resolve());
}

async function processEntry(entry) {
  if (!entry.isTorrent) {
    return entry;
  }
  return comoeubaixo.torrent(entry.torrentId)
      .then(records => Promises.sequence(records.map(record => () => processTorrentRecord(record))))
      .catch(() => undefined);
}

async function processTorrentRecord(foundTorrent) {
  if (await checkAndUpdateTorrent({ provider: NAME, ...foundTorrent })) {
    return foundTorrent;
  }

  if (!foundTorrent.size) {
    await updateTorrentSize(foundTorrent);
  }
  if (!Number.isInteger(foundTorrent.seeders)) {
    await updateCurrentSeeders(foundTorrent);
  }

  const torrent = {
    infoHash: foundTorrent.infoHash,
    provider: NAME,
    torrentId: foundTorrent.torrentId,
    title: foundTorrent.title,
    type: TYPE_MAPPING[foundTorrent.category],
    imdbId: foundTorrent.imdbId,
    uploadDate: foundTorrent.uploadDate,
    seeders: foundTorrent.seeders,
    size: foundTorrent.size,
    files: foundTorrent.files,
    languages: foundTorrent.languages
  };
  return createTorrentEntry(torrent);
}

function typeMapping() {
  const mapping = {};
  mapping[comoeubaixo.Categories.MOVIE] = Type.MOVIE;
  mapping[comoeubaixo.Categories.TV] = Type.SERIES;
  mapping[comoeubaixo.Categories.ANIME] = Type.ANIME;
  mapping[comoeubaixo.Categories.DESENHOS] = Type.SERIES;
  return mapping;
}

function untilPage(category) {
  if (comoeubaixo.Categories.DESENHOS === category) {
    return UNTIL_PAGE;
  }
  if (comoeubaixo.Categories.TV === category) {
    return UNTIL_PAGE;
  }
  return UNTIL_PAGE;
}

module.exports = { scrape, updateSeeders, NAME };
