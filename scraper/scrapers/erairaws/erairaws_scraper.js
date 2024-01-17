const moment = require('moment');
const Bottleneck = require('bottleneck');
const erairaws = require('./erairaws_api');
const { checkAndUpdateTorrent } = require('../../lib/torrentEntries');

const NAME = 'EraiRaws';

const limiter = new Bottleneck({ maxConcurrent: 10 });

async function scrape() {
  const scrapeStart = moment();
  console.log(`[${scrapeStart}] starting ${NAME} scrape...`);

  return scrapeLatestTorrents()
      .then(() => console.log(`[${moment()}] finished ${NAME} scrape`));
}

async function scrapeLatestTorrents() {
  return scrapeLatestTorrentsForCategory(erairaws.Categories.EPISODES)
      .then((entries) => entries.reduce((a, b) => a.concat(b), []));
}

async function scrapeLatestTorrentsForCategory(category, page = 1) {
  console.log(`Scrapping ${NAME} ${category} category page ${page}`);
  return erairaws.browse({ category, page })
      .catch((error) => {
        console.warn(`Failed ${NAME} scrapping for [${page}] ${category} due: `, error);
        return Promise.resolve([]);
      })
      .then((torrents) => Promise.all(torrents.map((torrent) => limiter.schedule(() => processRecord(torrent)))))
      .then((resolved) => resolved.length > 0 && page < untilPage(category)
          ? scrapeLatestTorrentsForCategory(category, page + 1)
          : Promise.resolve([]));
}

async function processRecord(foundTorrent) {
  return checkAndUpdateTorrent({ provider: NAME, ...foundTorrent }).then(() => foundTorrent);
}

function untilPage(category) {
  if (category === erairaws.Categories.ANIMES) {
    return 45;
  }
  return 3;
}

module.exports = { scrape, NAME };
