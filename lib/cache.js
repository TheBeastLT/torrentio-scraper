const cacheManager = require('cache-manager');
const mangodbStore = require('cache-manager-mongodb');

const GLOBAL_KEY_PREFIX = 'stremio-torrentio';
const IMDB_ID_PREFIX = `${GLOBAL_KEY_PREFIX}|imdb_id`;
const METADATA_PREFIX = `${GLOBAL_KEY_PREFIX}|metadata`;
const TORRENT_FILES_KEY_PREFIX = `stremio-tpb|files`;

const GLOBAL_TTL = process.env.METADATA_TTL || 7 * 24 * 60 * 60; // 7 days

const MONGO_URI = process.env.MONGODB_URI;

const cache = initiateCache();
const torrentFilesCache = initiateTorrentFilesCache();

function initiateTorrentFilesCache() {
  if (MONGO_URI) {
    return cacheManager.caching({
      store: mangodbStore,
      uri: MONGO_URI,
      options: {
        collection: 'cacheManager',
      },
      ttl: GLOBAL_TTL,
      ignoreCacheErrors: true
    });
  }
}

function initiateCache() {
  if (MONGO_URI) {
    return cacheManager.caching({
      store: mangodbStore,
      uri: MONGO_URI,
      options: {
        collection: 'torrentio_scraper_collection',
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

function retrieveTorrentFiles(infoHash) {
  return torrentFilesCache.get(`${TORRENT_FILES_KEY_PREFIX}:${infoHash}`)
      .then((results) => {
        if (!results) {
          throw new Error('No cached files found');
        }
        return results;
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

module.exports = { cacheWrapImdbId, cacheWrapMetadata, retrieveTorrentFiles };

