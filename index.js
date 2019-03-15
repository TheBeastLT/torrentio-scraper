const express = require("express");
const server = express();
const { connect } = require('./lib/repository');
const tpbDump = require('./scrapers/piratebay_dump');
const horribleSubs = require('./scrapers/api/horriblesubs');

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
  console.log('Scraper started');
  // const shows = await horribleSubs.allShows();
  // console.log(shows);
  // const showInfo = await horribleSubs.showData('/shows/one-piece');
  // console.log(showInfo)
  // const latestEntries = await horribleSubs.getLatestEntries();
  // console.log(latestEntries);
  //scrape();
});