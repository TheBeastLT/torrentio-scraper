import cacheManager from 'cache-manager';
import mangodbStore from 'cache-manager-mongodb';

const CATALOG_TTL = process.env.STREAM_TTL || 24 * 60 * 60; // 24 hours

const MONGO_URI = process.env.MONGODB_URI;

const remoteCache = initiateRemoteCache();

function initiateRemoteCache() {
  if (MONGO_URI) {
    return cacheManager.caching({
      store: mangodbStore,
      uri: MONGO_URI,
      options: {
        collection: 'torrentio_catalog_collection',
        socketTimeoutMS: 120000,
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

export function cacheWrapCatalog(key, method) {
  return cacheWrap(remoteCache, key, method, { ttl: CATALOG_TTL });
}

export function cacheWrapIds(key, method) {
  return cacheWrap(remoteCache, `ids|${key}`, method, { ttl: CATALOG_TTL });
}
