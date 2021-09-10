const express = require("express");
const server = express();
const serverless = require('./addon/serverless')
const { initBestTrackers } = require('./addon/lib/magnetHelper');
const { connect } = require('./scraper/lib/repository');
const { startScraper } = require('./scraper/scheduler/scheduler')

server.get('/', function (req, res) {
  res.sendStatus(200);
});


server.use((req, res, next) => serverless(req, res, next));
server.listen(process.env.PORT || 7000, async () => {
  await connect();
  console.log('Scraper started');
  startScraper();
  initBestTrackers()
    .then(() => console.log(`Started addon at: http://localhost:${process.env.PORT || 7000}`));
});