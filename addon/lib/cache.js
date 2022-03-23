const cacheManager = require('cache-manager');
const mangodbStore = require('cache-manager-mongodb');
const { RESOLVER_HOST } = require('../moch/static')

const GLOBAL_KEY_PREFIX = 'torrentio-addon';
const STREAM_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|stream`;
const AVAILABILITY_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|availability`;
const RESOLVED_URL_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|resolved`;

const STREAM_TTL = process.env.STREAM_TTL || 4 * 60 * 60; // 4 hours
const STREAM_EMPTY_TTL = process.env.STREAM_EMPTY_TTL || 30 * 60; // 30 minutes
const AVAILABILITY_TTL = 8 * 60 * 60; // 8 hours
const AVAILABILITY_EMPTY_TTL = 60 * 60; // 1 hours
const MESSAGE_VIDEO_URL_TTL = 60; // 1 minutes
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
        ttl: STREAM_EMPTY_TTL
      },
      ttl: STREAM_EMPTY_TTL,
      ignoreCacheErrors: true
    });
  } else {
    return cacheManager.caching({
      store: 'memory',
      ttl: STREAM_EMPTY_TTL
    });
  }
}

function initiateMemoryCache() {
  return cacheManager.caching({
    store: 'memory',
    ttl: MESSAGE_VIDEO_URL_TTL,
    max: Infinity // infinite LRU cache size
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
  return cacheWrap(memoryCache, `${RESOLVED_URL_KEY_PREFIX}:${id}`, method, {
    ttl: (url) => url.startsWith(RESOLVER_HOST) ? MESSAGE_VIDEO_URL_TTL : STREAM_TTL
  });
}

function cacheAvailabilityResults(results) {
  Object.keys(results)
      .forEach(infoHash => {
        const key = `${AVAILABILITY_KEY_PREFIX}:${infoHash}`;
        const value = results[infoHash];
        const ttl = value && value.length ? AVAILABILITY_TTL : AVAILABILITY_EMPTY_TTL;
        memoryCache.set(key, value, { ttl })
      });
  return results;
}

function getCachedAvailabilityResults(infoHashes) {
  const keys = infoHashes.map(infoHash => `${AVAILABILITY_KEY_PREFIX}:${infoHash}`)
  return new Promise(resolve => {
    memoryCache.mget(...keys, (error, result) => {
      if (error) {
        console.log('Failed retrieve availability cache', error)
        return resolve({});
      }
      const availabilityResults = {};
      infoHashes.forEach((infoHash, index) => {
        if (result[index]) {
          availabilityResults[infoHash] = result[index];
        }
      });
      resolve(availabilityResults);
    })
  });
}

module.exports = { cacheWrapStream, cacheWrapResolvedUrl, cacheAvailabilityResults, getCachedAvailabilityResults };

