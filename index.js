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
const thepiratebayDumpScraper = require('./scrapers/thepiratebay/thepiratebay_dump_scraper');
const thepiratebayUnofficialDumpScraper = require('./scrapers/thepiratebay/thepiratebay_unofficial_dump_scraper');

const PROVIDERS = [
  horribleSubsScraper,
  rarbgScraper,
  thepiratebayScraper,
  kickassScraper,
  leetxScraper
];
const SCRAPE_CRON = process.env.SCRAPE_CRON || '* 0/4 * * * *';

async function scrape() {
  return PROVIDERS
      .reduce((promise, scrapper) => promise
          .then(() => scrapper.scrape().catch(() => Promise.resolve())), Promise.resolve());
}

server.get('/', function (req, res) {
  res.send(200);
});

server.listen(process.env.PORT || 7000, async function () {
  await connect();
  schedule.scheduleJob(SCRAPE_CRON, () => scrape());
  console.log('Scraper started');
  scrape();
});