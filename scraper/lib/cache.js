const cacheManager = require('cache-manager');
const mangodbStore = require('cache-manager-mongodb');

const GLOBAL_KEY_PREFIX = 'stremio-torrentio';
const IMDB_ID_PREFIX = `${GLOBAL_KEY_PREFIX}|imdb_id`;
const KITSU_ID_PREFIX = `${GLOBAL_KEY_PREFIX}|kitsu_id`;
const METADATA_PREFIX = `${GLOBAL_KEY_PREFIX}|metadata`;
const RESOLVED_URL_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|moch`;
const PROXY_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|proxy`;
const TORRENT_FILES_KEY_PREFIX = `stremio-tpb|files`;

const GLOBAL_TTL = process.env.METADATA_TTL || 7 * 24 * 60 * 60; // 7 days
const MEMORY_TTL = process.env.METADATA_TTL || 2 * 60 * 60; // 2 hours
const PROXY_TTL = 8 * 60 * 60; // 8 hours

const MONGO_URI = process.env.MONGODB_URI;

const memoryCache = initiateMemoryCache();
const remoteCache = initiateRemoteCache();
const torrentFilesCache = initiateTorrentFilesCache();

function initiateTorrentFilesCache() {
  if (MONGO_URI) {
    return cacheManager.caching({
      store: mangodbStore,
      uri: MONGO_URI,
      options: {
        collection: 'cacheManager',
        useUnifiedTopology: true,
      },
      ttl: GLOBAL_TTL,
      ignoreCacheErrors: true
    });
  }
}

function initiateRemoteCache() {
  if (MONGO_URI) {
    return cacheManager.caching({
      store: mangodbStore,
      uri: MONGO_URI,
      options: {
        collection: 'torrentio_scraper_collection',
        useUnifiedTopology: true,
      },
      ttl: GLOBAL_TTL,
      ignoreCacheErrors: true
    });
  } else {
    return cacheManager.caching({
      store: 'memory',
      ttl: GLOBAL_TTL
    });
  }
}

function initiateMemoryCache() {
  return cacheManager.caching({
    store: 'memory',
    ttl: MEMORY_TTL
  });
}

function retrieveTorrentFiles(infoHash) {
  return torrentFilesCache.get(`${TORRENT_FILES_KEY_PREFIX}:${infoHash}`)
      .then((results) => {
        if (!results) {
          throw new Error('No cached files found');
        }
        return results;
      });
}

function cacheWrap(cache, key, method, options) {
  return cache.wrap(key, method, options);
}

function cacheWrapImdbId(key, method) {
  return cacheWrap(remoteCache, `${IMDB_ID_PREFIX}:${key}`, method, { ttl: GLOBAL_TTL });
}

function cacheWrapKitsuId(key, method) {
  return cacheWrap(remoteCache, `${KITSU_ID_PREFIX}:${key}`, method, { ttl: GLOBAL_TTL });
}

function cacheWrapMetadata(id, method) {
  return cacheWrap(memoryCache, `${METADATA_PREFIX}:${id}`, method, { ttl: MEMORY_TTL });
}

function cacheWrapResolvedUrl(id, method) {
  return cacheWrap(memoryCache, `${RESOLVED_URL_KEY_PREFIX}:${id}`, method, { ttl: { MEMORY_TTL } });
}

function cacheWrapProxy(id, method) {
  return cacheWrap(memoryCache, `${PROXY_KEY_PREFIX}:${id}`, method, { ttl: { PROXY_TTL } });
}

module.exports = {
  cacheWrapImdbId,
  cacheWrapKitsuId,
  cacheWrapMetadata,
  retrieveTorrentFiles,
  cacheWrapResolvedUrl,
  cacheWrapProxy
};

