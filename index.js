const express = require("express");
const server = express();
const { init } = require('./lib/torrent');
const { connect } = require('./lib/repository');
const tpbDump = require('./scrapers/piratebay_dump');
const horribleSubsScraper = require('./scrapers/horiblesubs_scraper');

const providers = [tpbDump];

async function scrape() {
  providers.forEach((provider) => provider.scrape());
}

server.post('/scrape', function(req, res) {
  scrape();
  res.send(200);
});

server.listen(7000, async function () {
  await connect();
  await init();
  console.log('Scraper started');
  scrape();
});