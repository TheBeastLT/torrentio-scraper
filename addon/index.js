import './lib/httpAgent.js';
import express from 'express';
import serverless, { redisClient } from './serverless.js';
import { initBestTrackers } from './lib/magnetHelper.js';
import { closeDatabase } from './lib/repository.js';
import { closeCache } from './lib/cache.js';
import { metricsMiddleware, metricsHandler } from './lib/metrics.js';

const app = express();
app.enable('trust proxy');
app.get('/metrics', metricsHandler);
app.use(metricsMiddleware);
app.use(express.static('static', { maxAge: '1y' }));
app.use((req, res, next) => serverless(req, res, next));
const server = app.listen(process.env.PORT || 7000, () => {
  initBestTrackers()
      .then(() => console.log(`Started addon at: http://localhost:${process.env.PORT || 7000}`));
});

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully`);
  const forced = setTimeout(() => process.exit(1), 15000);
  await new Promise(resolve => server.close(resolve));
  await Promise.allSettled([closeDatabase(), closeCache(), redisClient.quit()]);
  clearTimeout(forced);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
