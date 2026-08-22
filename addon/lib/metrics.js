import client from 'prom-client';
import { performance } from 'node:perf_hooks';
import { MochOptions, queueDepths, blacklistSize } from '../moch/moch.js';
import { poolStats } from './repository.js';

const register = new client.Registry();
register.setDefaultLabels({ app: 'torrentio-addon' });
client.collectDefaultMetrics({ register });

let prevElu = performance.eventLoopUtilization();
new client.Gauge({
  name: 'nodejs_eventloop_utilization',
  help: 'Event loop utilization over the scrape interval (0-1)',
  registers: [register],
  collect() {
    const current = performance.eventLoopUtilization();
    this.set(performance.eventLoopUtilization(current, prevElu).utilization);
    prevElu = current;
  }
});

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['resource', 'status'],
  buckets: [0.05, 0.1, 0.5, 1, 2.5, 10, 30],
  registers: [register]
});

const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by resource and debrid provider',
  labelNames: ['resource', 'moch'],
  registers: [register]
});

const dbDuration = new client.Histogram({
  name: 'db_operation_duration_seconds',
  help: 'Postgres query duration',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

const cacheDuration = new client.Histogram({
  name: 'cache_operation_duration_seconds',
  help: 'Cache backing-store (Mongo) operation duration',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

const cacheRequests = new client.Counter({
  name: 'cache_requests_total',
  help: 'Cache lookups by serving tier',
  labelNames: ['cache', 'result'],
  registers: [register]
});

const mochResolve = new client.Histogram({
  name: 'moch_resolve_duration_seconds',
  help: 'Debrid resolve duration by moch and outcome',
  labelNames: ['moch', 'outcome'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register]
});

const mochAvailability = new client.Histogram({
  name: 'moch_availability_duration_seconds',
  help: 'Debrid availability check duration by moch and outcome',
  labelNames: ['moch', 'outcome'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 20, 30],
  registers: [register]
});

const mochQueueWait = new client.Histogram({
  name: 'moch_queue_wait_seconds',
  help: 'Wait time in the per-moch unrestrict queue before the API call',
  labelNames: ['moch'],
  buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register]
});

const tokenBlacklistEvents = new client.Counter({
  name: 'moch_token_blacklist_events_total',
  help: 'Tokens added to the moch blacklist',
  labelNames: ['moch'],
  registers: [register]
});

const rateLimiterStoreErrors = new client.Counter({
  name: 'rate_limiter_store_errors_total',
  help: 'Rate limiter Redis store errors (requests pass un-limited while these occur)',
  registers: [register]
});

export function observeDb(operation, seconds) {
  dbDuration.observe({ operation }, seconds);
}

export function cacheTimer(operation) {
  return cacheDuration.startTimer({ operation });
}

export function cacheResult(cache, result) {
  cacheRequests.inc({ cache, result });
}

export function mochResolveTimer(moch) {
  return mochResolve.startTimer({ moch });
}

export function mochAvailabilityTimer(moch) {
  return mochAvailability.startTimer({ moch });
}

export function mochQueueTimer(moch) {
  return mochQueueWait.startTimer({ moch });
}

export function recordTokenBlacklist(moch) {
  tokenBlacklistEvents.inc({ moch });
}

export function recordRateLimiterStoreError() {
  rateLimiterStoreErrors.inc();
}

const mochBreakerEvents = new client.Counter({
  name: 'moch_breaker_events_total',
  help: 'Resolve circuit breaker events by moch and event',
  labelNames: ['moch', 'event'],
  registers: [register],
});

export function recordBreakerEvent(moch, event) {
  mochBreakerEvents.inc({ moch, event });
}

new client.Gauge({
  name: 'moch_queue_waiting',
  help: 'Waiting tasks in the per-moch unrestrict queue',
  labelNames: ['moch'],
  registers: [register],
  collect() {
    Object.entries(queueDepths()).forEach(([moch, depth]) => this.set({ moch }, depth));
  }
});

new client.Gauge({
  name: 'moch_token_blacklist_size',
  help: 'Size of the in-memory moch token blacklist',
  registers: [register],
  collect() {
    this.set(blacklistSize());
  }
});

new client.Gauge({
  name: 'db_pool_connections',
  help: 'Sequelize connection pool state',
  labelNames: ['state'],
  registers: [register],
  collect() {
    Object.entries(poolStats()).forEach(([state, value]) => this.set({ state }, value));
  }
});

const KNOWN_RESOURCES = new Set(['stream', 'meta', 'catalog']);
let knownMochs;

function isKnownMoch(key) {
  knownMochs ??= new Set(Object.values(MochOptions).map(moch => moch.key));
  return knownMochs.has(key);
}

function configMoch(configSegment = '') {
  let decoded;
  try {
    decoded = decodeURIComponent(configSegment);
  } catch {
    decoded = configSegment;
  }
  const mochs = [...new Set(decoded.split('|')
      .map(pair => pair.split('=')[0].toLowerCase())
      .filter(key => isKnownMoch(key)))];
  if (mochs.length === 1) {
    return mochs[0];
  }
  return mochs.length > 1 ? 'multiple' : 'na';
}

function routeLabels(req) {
  const path = req.url.split('?')[0];
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'resolve') {
    return { resource: 'resolve', moch: configMoch(parts[1]) };
  }
  const idx = parts.findIndex(part => KNOWN_RESOURCES.has(part));
  if (idx >= 0) {
    const resource = parts[idx];
    const moch = configMoch(parts[idx - 1]);
    return { resource, moch };
  }
  if (path.includes('manifest.json')) {
    return { resource: 'manifest', moch: 'na' };
  }
  if (path.includes('/configure')) {
    return { resource: 'configure', moch: 'na' };
  }
  return { resource: 'other', moch: 'na' };
}

export function metricsMiddleware(req, res, next) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    try {
      const { resource, moch } = routeLabels(req);
      end({ resource, status: res.statusCode });
      httpRequests.inc({ resource, moch });
    } catch (error) {
      console.error('Failed recording request metric', error?.message || error);
    }
  });
  next();
}

export async function metricsHandler(req, res) {
  const encoded = (req.headers.authorization || '').split(' ')[1] || '';
  const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
  if (user !== process.env.METRICS_USER || pass !== process.env.METRICS_PASSWORD) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Basic realm="metrics"');
    return res.end('Unauthorized');
  }
  try {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    console.error('Failed rendering metrics', error?.message || error);
    res.statusCode = 500;
    res.end();
  }
}
