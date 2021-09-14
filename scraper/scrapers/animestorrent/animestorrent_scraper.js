const moment = require("moment");
const Bottleneck = require("bottleneck");
const animetorrrent = require("./animestorrent_api");
const { Type } = require("../../lib/types");
const repository = require("../../lib/repository");
const Promises = require("../../lib/promises");
const { createTorrentEntry, checkAndUpdateTorrent } = require("../../lib/torrentEntries");
const { updateCurrentSeeders, updateTorrentSize } = require("../../lib/torrent");
const { getKitsuId } = require("../../lib/metadata");

const NAME = "AnimesTorrent";
const UNTIL_PAGE = 5;

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
  return limiter.schedule(() => animetorrrent.torrent(torrent.torrentId));
}

async function scrapeLatestTorrents() {
  const allowedCategories = [
    animetorrrent.Categories.MOVIE,
    animetorrrent.Categories.ANIME,
    animetorrrent.Categories.OVA
  ];

  return Promises.sequence(allowedCategories
          .map((category) => () => scrapeLatestTorrentsForCategory(category)))
      .then((entries) => entries.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrentsForCategory(category, page = 1) {
  console.log(`Scrapping ${NAME} ${category} category page ${page}`);
  return animetorrrent
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
  return animetorrrent.torrent(entry.torrentId)
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
  if (!foundTorrent.imdbId && !foundTorrent.kitsuId) {
    const info = { title: foundTorrent.originalName, year: foundTorrent.year };
    foundTorrent.kitsuId = await getKitsuId(info).catch(() => undefined);
  }

  const torrent = {
    infoHash: foundTorrent.infoHash,
    provider: NAME,
    torrentId: foundTorrent.torrentId,
    title: foundTorrent.title,
    type: Type.ANIME,
    imdbId: foundTorrent.imdbId,
    kitsuId: foundTorrent.kitsuId,
    uploadDate: foundTorrent.uploadDate,
    seeders: foundTorrent.seeders,
    size: foundTorrent.size,
    files: foundTorrent.files,
    languages: foundTorrent.languages
  };
  return createTorrentEntry(torrent);
}

function untilPage(category) {
  if (animetorrrent.Categories.ANIME === category) {
    return 5;
  }
  if (animetorrrent.Categories.OVA === category) {
    return 3;
  }
  return UNTIL_PAGE;
}

module.exports = { scrape, updateSeeders, NAME };
