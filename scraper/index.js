require('dotenv').config();
const express = require("express");
const server = express();
const schedule = require('node-schedule');
const { connect, getUpdateSeedersTorrents } = require('./lib/repository');
const thepiratebayScraper = require('./scrapers/thepiratebay/thepiratebay_scraper');
const horribleSubsScraper = require('./scrapers/horriblesubs/horriblesubs_scraper');
const leetxScraper = require('./scrapers/1337x/1337x_scraper');
const kickassScraper = require('./scrapers/kickass/kickass_scraper');
const rarbgScraper = require('./scrapers/rarbg/rarbg_scraper');
const rarbgDumpScraper = require('./scrapers/rarbg/rarbg_dump_scraper');
const thepiratebayDumpScraper = require('./scrapers/thepiratebay/thepiratebay_dump_scraper');
const thepiratebayUnofficialDumpScraper = require('./scrapers/thepiratebay/thepiratebay_unofficial_dump_scraper');

const PROVIDERS = [
  // require('./scrapers/thepiratebay/thepiratebay_update_size_scraper')
  // require('./scrapers/1337x/1337x_dump_scraper')
  horribleSubsScraper,
  rarbgScraper,
  thepiratebayScraper,
  kickassScraper,
  leetxScraper
  // rarbgDumpScraper
  // thepiratebayDumpScraper
  // thepiratebayUnofficialDumpScraper
];
const SCRAPE_CRON = process.env.SCRAPE_CRON || '0 0 */4 ? * *'; // every 4 hours
const SEEDERS_CRON = '0 */2 * ? * *'; // every 2 minutes

async function scrape() {
  return PROVIDERS
      .reduce(async (previousPromise, nextProvider) => {
        await previousPromise;
        return nextProvider.scrape().catch(error => {
          console.warn(`Failed ${nextProvider.NAME} scraping due: `, error);
          return Promise.resolve()
        });
      }, Promise.resolve());
}

async function updateSeeders() {
  return getUpdateSeedersTorrents()
      .then(torrents => Promise.all(torrents
          .map(torrent => PROVIDERS.find(provider => provider.NAME === torrent.provider)
              .updateSeeders(torrent))))
      .then(() => console.log('Finished updating seeders'));
}

function enableScheduling() {
  if (process.env.ENABLE_SCHEDULING) {
    schedule.scheduleJob(SCRAPE_CRON,
        () => scrape().catch(error => console.error('Failed scraping: ', error)));
    // schedule.scheduleJob(SEEDERS_CRON,
    //     () => updateSeeders().catch(error => console.error('Failed update seeders: ', error)));
  } else {
    scrape().catch(error => console.error('Failed scraping: ', error));
  }
}

server.get('/', function (req, res) {
  res.sendStatus(200);
});

server.listen(process.env.PORT || 7000, async () => {
  await connect();
  console.log('Scraper started');
  enableScheduling();
});