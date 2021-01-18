const express = require('express');
const serverless = require('./serverless');
const { initBestTrackers } = require('./lib/magnetHelper');

const app = express();

app.use(express.static('static', { maxAge: '1y' }));
app.use((req, res, next) => serverless(req, res, next));
app.listen(process.env.PORT || 7000, () => {
  initBestTrackers()
      .then(() => console.log(`Started addon at: http://localhost:${process.env.PORT || 7000}`))
      .catch(error => console.error('Failed init trackers', error));
});
