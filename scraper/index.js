const express = require("express");
const server = express();
const { connect } = require('./lib/repository');
const { startScraper } = require('./scheduler/scheduler')

server.get('/', function (req, res) {
  res.sendStatus(200);
});

server.listen(process.env.PORT || 7000, async () => {
  await connect();
  console.log('Scraper started');
  startScraper();
});