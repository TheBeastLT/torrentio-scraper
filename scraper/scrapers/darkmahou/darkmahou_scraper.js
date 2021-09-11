const moment = require("moment");
const Bottleneck = require("bottleneck");
const leetx = require("./darkmahou_api");
const { Type } = require("../../lib/types");
const repository = require("../../lib/repository");
const Promises = require("../../lib/promises");
const { createTorrentEntry, checkAndUpdateTorrent } = require("../../lib/torrentEntries");
const { updateCurrentSeeders, updateTorrentSize } = require("../../lib/torrent");
const { getImdbId } = require("../../lib/metadata");

const NAME = "DarkMahou";
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
  return limiter.schedule(() => leetx.torrent(torrent.torrentId));
}

async function scrapeLatestTorrents() {
  const allowedCategories = [
    leetx.Categories.MOVIE,
    leetx.Categories.ANIME,
    leetx.Categories.OVA
  ];

  return Promises.sequence(
    allowedCategories.map(
      (category) => () => scrapeLatestTorrentsForCategory(category)
    )
  ).then((entries) => entries.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrentsForCategory(category, page = 1) {
  console.log({Scraper: `Scrapping ${NAME} ${category} category page ${page}`});
  return leetx
    .browse({ category, page })
    .catch((error) => {
      console.warn(
        `Failed ${NAME} scrapping for [${page}] ${category} due: `,
        error
      );
      return Promise.resolve([]);
    })
    .then((torrents) => Promise.all(torrents.map((torrent) => limiter.schedule(() => processTorrentRecord(torrent)))))
    .then((resolved) => resolved.length > 0 && page < untilPage(category) ? scrapeLatestTorrentsForCategory(category, page + 1) : Promise.resolve());
}

async function processTorrentRecord(record) {
  if (await checkAndUpdateTorrent({ provider: NAME, ...record })) {
    return record;
  }
  const torrentEntrys = await leetx
    .torrent(record.torrentId)
    .catch(() => undefined);
  if (torrentEntrys === undefined) {
    return Promise.resolve([])
  }
  return Promise.allSettled(
    torrentEntrys.map(async (torrentFound) => {
      if (!torrentFound || !TYPE_MAPPING[torrentFound.category]) {
        return Promise.resolve("Invalid torrent record");
      }
      if (isNaN(torrentFound.uploadDate)) {
        console.warn(
          `Incorrect upload date for [${torrentFound.infoHash}] ${torrentFound.name}`
        );
        return;
      }
     if (await checkAndUpdateTorrent(torrentFound)) {
        return torrentFound;
      }
      if (!torrentFound.size) {
        await updateTorrentSize(torrentFound)
        .catch((err) => Promise.resolve(err))
      }
      if (!torrentFound.seeders) {
        await updateCurrentSeeders(torrentFound)
        .then(response => response.seeders === 0 ? delete response.seeders : response)
      }
      if (!torrentFound.imdbId) {
        torrentFound.imdbId = await getImdbId(torrentFound.original_name, torrentFound.year, TYPE_MAPPING[torrentFound.category])
      }
      const torrent = {
        infoHash: torrentFound.infoHash,
        provider: NAME,
        torrentId: torrentFound.torrentId,
        title: torrentFound.title.replace(/\t|\s+/g, " ").trim(),
        type: Type.ANIME,
        imdbId: torrentFound.imdbId,
        uploadDate: torrentFound.uploadDate,
        seeders: torrentFound.seeders,
      };
      return createTorrentEntry(torrent);
    })
  );
}

function typeMapping() {
  const mapping = {};
  mapping[leetx.Categories.MOVIE] = Type.MOVIE;
  mapping[leetx.Categories.ANIME] = Type.SERIES;
  mapping[leetx.Categories.OVA] = Type.ANIME
  return mapping;
}

function untilPage(category) {
  if (leetx.Categories.ANIME === category) {
    return 5;
  }
  if (leetx.Categories.OVA === category) {
    return 4;
  }
  return UNTIL_PAGE;
}

module.exports = { scrape, updateSeeders, NAME };
