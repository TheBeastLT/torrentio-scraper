require('dotenv').config();
const express = require("express");
const server = express();
const schedule = require('node-schedule');
const { connect } = require('./lib/repository');
const thepiratebayScraper = require('./scrapers/thepiratebay/thepiratebay_scraper');
const horribleSubsScraper = require('./scrapers/horriblesubs/horriblesubs_scraper');
const leetxScraper = require('./scrapers/1337x/1337x_scraper');
const kickassScraper = require('./scrapers/kickass/kickass_scraper');
const rarbgScraper = require('./scrapers/rarbg/rarbg_scraper');
const rarbgDumpScraper = require('./scrapers/rarbg/rarbg_dump_scraper');
const thepiratebayDumpScraper = require('./scrapers/thepiratebay/thepiratebay_dump_scraper');
const thepiratebayUnofficialDumpScraper = require('./scrapers/thepiratebay/thepiratebay_unofficial_dump_scraper');

const PROVIDERS = [
  horribleSubsScraper,
  rarbgScraper,
  thepiratebayScraper,
  kickassScraper,
  leetxScraper
  // rarbgDumpScraper
];
const SCRAPE_CRON = process.env.SCRAPE_CRON || '* * 0/4 * * *';

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

function enableScheduling() {
  if (process.env.ENABLE_SCHEDULING) {
    schedule.scheduleJob(SCRAPE_CRON, () => scrape().catch(error => console.error('Failed scraping: ', error)));
  } else {
    scrape().catch(error => console.error('Failed scraping: ', error));
  }
}

server.get('/', function (req, res) {
  res.send(200);
});

server.listen(process.env.PORT || 7000, async () => {
  await connect();
  console.log('Scraper started');
  enableScheduling();
});