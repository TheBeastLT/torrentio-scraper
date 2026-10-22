import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import client from 'prom-client';

const WORKERS = Math.min(Number(process.env.ADDON_WORKERS) || 1, availableParallelism());
const RESTART_DELAY = 1000;

if (WORKERS <= 1 || cluster.isWorker) {
  await import('./index.js');
} else {
  const aggregator = new client.AggregatorRegistry();
  let stopping = false;

  console.log(`Starting ${WORKERS} addon workers`);
  for (let i = 0; i < WORKERS; i++) {
    cluster.fork();
  }

  cluster.on('message', (worker, message) => {
    if (message?.type !== 'metrics-request') {
      return;
    }
    aggregator.clusterMetrics()
        .then(metrics => worker.send({ type: 'metrics-response', id: message.id, metrics }))
        .catch(error => worker.send({ type: 'metrics-response', id: message.id, error: error?.message || error }));
  });

  cluster.on('exit', (worker, code, signal) => {
    if (stopping) {
      if (!Object.keys(cluster.workers).length) {
        process.exit(0);
      }
      return;
    }
    console.error(`Worker ${worker.process.pid} exited (${signal || code}), restarting`);
    setTimeout(() => cluster.fork(), RESTART_DELAY);
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`Received ${signal}, stopping workers`);
      stopping = true;
      const workers = Object.values(cluster.workers);
      workers.forEach(worker => worker.process.kill(signal));
      if (!workers.length) {
        process.exit(0);
      }
    });
  }
}
