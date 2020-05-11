const cacheManager = require('cache-manager');
const mangodbStore = require('cache-manager-mongodb');

const GLOBAL_KEY_PREFIX = 'torrentio-addon';
const STREAM_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|stream`;
const RESOLVED_URL_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|resolved`;
const PROXY_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|proxy`;
const USER_AGENT_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|agent`;

const STREAM_TTL = process.env.STREAM_TTL || 4 * 60 * 60; // 4 hours
const STREAM_EMPTY_TTL = process.env.STREAM_EMPTY_TTL || 30 * 60; // 30 minutes
const RESOLVED_URL_TTL = 60; // 1 minutes
const PROXY_TTL = 60 * 60; // 60 minutes
const USER_AGENT_TTL = 2 * 24 * 60 * 60; // 2 days
// When the streams are empty we want to cache it for less time in case of timeouts or failures

const MONGO_URI = process.env.MONGODB_URI;
const NO_CACHE = process.env.NO_CACHE || false;

const memoryCache = initiateMemoryCache();
const remoteCache = initiateRemoteCache();

function initiateRemoteCache() {
  if (NO_CACHE) {
    return null;
  } else if (MONGO_URI) {
    return cacheManager.caching({
      store: mangodbStore,
      uri: MONGO_URI,
      options: {
        collection: 'torrentio_addon_collection',
        useNewUrlParser: true,
        useUnifiedTopology: false,
        ttl: STREAM_TTL
      },
      ttl: STREAM_TTL,
      ignoreCacheErrors: true
    });
  } else {
    return cacheManager.caching({
      store: 'memory',
      ttl: STREAM_TTL
    });
  }
}

function initiateMemoryCache() {
  return cacheManager.caching({
    store: 'memory',
    ttl: STREAM_TTL
  });
}

function cacheWrap(cache, key, method, options) {
  if (NO_CACHE || !cache) {
    return method();
  }
  return cache.wrap(key, method, options);
}

function cacheWrapStream(id, method) {
  return cacheWrap(remoteCache, `${STREAM_KEY_PREFIX}:${id}`, method, {
    ttl: (streams) => streams.length ? STREAM_TTL : STREAM_EMPTY_TTL
  });
}

function cacheWrapResolvedUrl(id, method) {
  return cacheWrap(memoryCache, `${RESOLVED_URL_KEY_PREFIX}:${id}`, method, { ttl: { RESOLVED_URL_TTL } });
}

function cacheWrapProxy(id, method) {
  return cacheWrap(memoryCache, `${PROXY_KEY_PREFIX}:${id}`, method, { ttl: { PROXY_TTL } });
}

function cacheUserAgent(id, method) {
  return cacheWrap(memoryCache, `${USER_AGENT_KEY_PREFIX}:${id}`, method, { ttl: { USER_AGENT_TTL } });
}

module.exports = { cacheWrapStream, cacheWrapResolvedUrl, cacheWrapProxy, cacheUserAgent };

