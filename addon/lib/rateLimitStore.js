const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FLUSH_INTERVAL = 30 * 1000;

function utcDay(now) {
  return Math.floor(now / DAY_MS);
}

export default class SyncedRateLimitStore {
  constructor(redisClient, { prefix = 'torrentio:ratelimit:', flushInterval = DEFAULT_FLUSH_INTERVAL, onError = () => {} } = {}) {
    this.redisClient = redisClient;
    this.prefix = prefix;
    this.flushInterval = flushInterval;
    this.onError = onError;
    this.window = this.newWindow(Date.now());
    this.flushing = null;
  }

  init() {
    clearInterval(this.timer);
    this.timer = setInterval(() => !this.flushing && this.flush(), this.flushInterval);
    this.timer.unref?.();
  }

  newWindow(now) {
    const day = utcDay(now);
    return { day, resetTime: new Date((day + 1) * DAY_MS), clients: new Map() };
  }

  currentWindow() {
    const now = Date.now();
    if (utcDay(now) !== this.window.day) {
      const previous = this.window;
      this.window = this.newWindow(now);
      this.flushWindow(previous);
    }
    return this.window;
  }

  async get(key) {
    const window = this.currentWindow();
    const client = window.clients.get(key);
    return client && { totalHits: client.total, resetTime: window.resetTime };
  }

  async increment(key) {
    const window = this.currentWindow();
    let client = window.clients.get(key);
    if (!client) {
      client = { total: 0, delta: 0 };
      window.clients.set(key, client);
    }
    client.total++;
    client.delta++;
    return { totalHits: client.total, resetTime: window.resetTime };
  }

  async decrement(key) {
    const client = this.currentWindow().clients.get(key);
    if (client && client.total > 0) {
      client.total--;
      client.delta--;
    }
  }

  async resetKey(key) {
    this.currentWindow().clients.delete(key);
  }

  async resetAll() {
    this.currentWindow().clients.clear();
  }

  flush() {
    const run = (this.flushing || Promise.resolve()).then(() => this.flushWindow(this.currentWindow()));
    this.flushing = run;
    run.finally(() => {
      if (this.flushing === run) {
        this.flushing = null;
      }
    });
    return run;
  }

  async flushWindow(window) {
    const dirty = [...window.clients].filter(([, client]) => client.delta !== 0)
        .map(([key, client]) => ({ key, client, sent: client.delta }));
    if (!dirty.length) {
      return;
    }
    if (!this.redisClient.isReady) {
      this.onError(new Error('redis client not ready'));
      return;
    }
    const hashKey = `${this.prefix}${window.day}`;
    try {
      const multi = this.redisClient.multi();
      dirty.forEach(({ key, sent }) => multi.hIncrBy(hashKey, key, sent));
      multi.pExpireAt(hashKey, window.resetTime.getTime() + DAY_MS);
      const totals = await multi.exec();
      dirty.forEach(({ client, sent }, index) => {
        const total = Number(totals[index]);
        if (Number.isFinite(total)) {
          client.delta -= sent;
          client.total = total + client.delta;
        }
      });
    } catch (error) {
      this.onError(error);
    }
  }
}
