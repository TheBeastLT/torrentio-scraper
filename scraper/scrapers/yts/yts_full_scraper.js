const moment = require("moment");
const yts = require('./yts_api');
const scraper = require('./yts_scraper')


async function scrape() {
  const scrapeStart = moment();
  console.log(`[${scrapeStart}] starting ${scraper.NAME} full scrape...`);

  return yts.maxPage()
      .then(maxPage => scraper.scrape(maxPage))
      .then(() => console.log(`[${moment()}] finished ${scraper.NAME} full scrape`));
}

module.exports = { scrape, NAME: scraper.NAME };