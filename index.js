require('dotenv').config();
const express = require("express");
const server = express();
const { connect } = require('./lib/repository');
const thepiratebayScraper = require('./scrapers/thepiratebay/thepiratebay_scraper');
const horribleSubsScraper = require('./scrapers/horriblesubs/horriblesubs_scraper');
const leetxScraper = require('./scrapers/1337x/1337x_scraper');
const kickassScraper = require('./scrapers/kickass/kickass_scraper');
const thepiratebayDumpScraper = require('./scrapers/thepiratebay/thepiratebay_dump_scraper');
const thepiratebayUnofficialDumpScraper = require('./scrapers/thepiratebay/thepiratebay_unofficial_dump_scraper');

const providers = [
  // horribleSubsScraper,
  // thepiratebayScraper,
  kickassScraper,
  // leetxScraper
];

async function scrape() {
  return providers
      .reduce((promise, scrapper) => promise.then(() => scrapper.scrape()), Promise.resolve());
}

server.get('/', function (req, res) {
  res.send(200);
});

server.post('/scrape', function (req, res) {
  scrape();
  res.send(200);
});

server.listen(process.env.PORT || 7000, async function () {
  await connect();
  console.log('Scraper started');
  scrape();
});