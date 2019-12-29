const cacheManager = require('cache-manager');

const GLOBAL_KEY_PREFIX = 'stremio-torrentio';
const IMDB_ID_PREFIX = `${GLOBAL_KEY_PREFIX}|imdb_id`;
const METADATA_PREFIX = `${GLOBAL_KEY_PREFIX}|metadata`;

const GLOBAL_TTL = process.env.METADATA_TTL || 7 * 24 * 60 * 60; // 7 days


const cache = initiateCache();

function initiateCache() {
  return cacheManager.caching({
    store: 'memory',
    ttl: GLOBAL_TTL
  });
}

function cacheWrap(key, method, options) {
  return cache.wrap(key, method, options);
}

function cacheWrapImdbId(key, method) {
  return cacheWrap(`${IMDB_ID_PREFIX}:${key}`, method, { ttl: GLOBAL_TTL });
}

function cacheWrapMetadata(id, method) {
  return cacheWrap(`${METADATA_PREFIX}:${id}`, method, { ttl: GLOBAL_TTL });
}

module.exports = { cacheWrapImdbId, cacheWrapMetadata };

