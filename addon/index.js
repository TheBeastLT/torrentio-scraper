const express = require('express');
const rateLimit = require("express-rate-limit");
const requestIp = require("request-ip");
const serverless = require('./serverless');
const { initBestTrackers } = require('./lib/magnetHelper');

const app = express();
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hours
  max: 300, // limit each IP to 300 requests per windowMs
  headers: false,
  keyGenerator: (req) => requestIp.getClientIp(req)
});

app.use(express.static('static', { maxAge: '1y' }));
app.use(/^\/.*stream\/.+/, limiter);
app.use((req, res, next) => serverless(req, res, next));
app.listen(process.env.PORT || 7000, () => {
  initBestTrackers()
      .then(() => console.log(`Started addon at: http://localhost:${process.env.PORT || 7000}`));
});
