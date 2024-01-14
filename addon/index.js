import express from 'express';
import serverless from './serverless.js';
import { initBestTrackers } from './lib/magnetHelper.js';

const app = express();
app.enable('trust proxy');
app.use(express.static('static', { maxAge: '1y' }));
app.use((req, res, next) => serverless(req, res, next));
app.listen(process.env.PORT || 7000, () => {
  initBestTrackers()
      .then(() => console.log(`Started addon at: http://localhost:${process.env.PORT || 7000}`));
});
