const cacheManager = require('cache-manager');
const mangodbStore = require('cache-manager-mongodb');

const CATALOG_TTL = process.env.STREAM_TTL || 12 * 60 * 60; // 12 hours

const MONGO_URI = process.env.MONGODB_URI;

const remoteCache = initiateRemoteCache();

function initiateRemoteCache() {
  if (MONGO_URI) {
    return cacheManager.caching({
      store: mangodbStore,
      uri: MONGO_URI,
      options: {
        collection: 'torrentio_catalog_collection',
        useNewUrlParser: true,
        useUnifiedTopology: false,
        ttl: CATALOG_TTL
      },
      ttl: CATALOG_TTL,
      ignoreCacheErrors: true
    });
  } else {
    return cacheManager.caching({
      store: 'memory',
      ttl: CATALOG_TTL
    });
  }
}

function cacheWrap(cache, key, method, options) {
  if (!cache) {
    return method();
  }
  return cache.wrap(key, method, options);
}

function cacheWrapCatalog(key, method) {
  return cacheWrap(remoteCache, key, method, { ttl: CATALOG_TTL });
}

function cacheWrapIds(key, method) {
  return cacheWrap(remoteCache, `ids|${key}`, method, { ttl: CATALOG_TTL });
}

module.exports = { cacheWrapCatalog, cacheWrapIds };

