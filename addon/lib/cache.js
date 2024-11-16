import KeyvMongo from "@keyv/mongo";
import { KeyvCacheableMemory } from "cacheable";
import { isStaticUrl }  from '../moch/static.js';

const GLOBAL_KEY_PREFIX = 'torrentio-addon';
const STREAM_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|stream`;
const AVAILABILITY_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|availability`;
const RESOLVED_URL_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|resolved`;

const STREAM_TTL = 24 * 60 * 60 * 1000; // 24 hours
const STREAM_EMPTY_TTL = 60 * 1000; // 1 minute
const RESOLVED_URL_TTL = 3 * 60 * 60 * 1000; // 3 hours
const AVAILABILITY_TTL = 8 * 60 * 60 * 1000; // 8 hours
const AVAILABILITY_EMPTY_TTL = 30 * 60 * 1000; // 30 minutes
const MESSAGE_VIDEO_URL_TTL = 60 * 1000; // 1 minutes
// When the streams are empty we want to cache it for less time in case of timeouts or failures

const MONGO_URI = process.env.MONGODB_URI;

const memoryCache = new KeyvCacheableMemory({ ttl: MESSAGE_VIDEO_URL_TTL, lruSize: Infinity });
const remoteCache = MONGO_URI && new KeyvMongo(MONGO_URI, { collection: 'torrentio_addon_collection' });

async function cacheWrap(cache, key, method, ttl) {
  if (!cache) {
    return method();
  }
  const value = await cache.get(key);
  if (value !== undefined) {
    return value;
  }
  const result = await method();
  const ttlValue = ttl instanceof Function ? ttl(result) : ttl;
  await cache.set(key, result, ttlValue);
  return result;
}

export function cacheWrapStream(id, method) {
  const ttl = (streams) => streams.length ? STREAM_TTL : STREAM_EMPTY_TTL;
  return cacheWrap(remoteCache, `${STREAM_KEY_PREFIX}:${id}`, method, ttl);
}

export function cacheWrapResolvedUrl(id, method) {
  const ttl = (url) => isStaticUrl(url) ? MESSAGE_VIDEO_URL_TTL : RESOLVED_URL_TTL;
  return cacheWrap(remoteCache, `${RESOLVED_URL_KEY_PREFIX}:${id}`, method, ttl);
}

export function cacheAvailabilityResults(results) {
  const items = Object.keys(results)
      .map(infoHash => {
        const key = `${AVAILABILITY_KEY_PREFIX}:${infoHash}`;
        const value = results[infoHash];
        const ttl = value?.length ? AVAILABILITY_TTL : AVAILABILITY_EMPTY_TTL;
        return {key, value, ttl };
      });
  memoryCache.setMany(items);
  return results;
}

export function getCachedAvailabilityResults(infoHashes) {
  const keys = infoHashes.map(infoHash => `${AVAILABILITY_KEY_PREFIX}:${infoHash}`)
  return memoryCache.getMany(keys)
      .then(result => {
        const availabilityResults = {};
        infoHashes.forEach((infoHash, index) => {
          if (result[index]) {
            availabilityResults[infoHash] = result[index];
          }
        });
        return availabilityResults;
      })
      .catch(error => {
        console.log('Failed retrieve availability cache', error)
        return {};
      });
}
