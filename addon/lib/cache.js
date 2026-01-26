import KeyvMongo from "@keyv/mongo";
import KeyvRedis from "@keyv/redis";
import { KeyvCacheableMemory } from "cacheable";
import { isStaticUrl }  from '../moch/static.js';

const GLOBAL_KEY_PREFIX = 'torrentio-addon';
const STREAM_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|stream`;
const AVAILABILITY_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|availability`;
const RESOLVED_URL_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|resolved`;

const STREAM_TTL = 24 * 60 * 60 * 1000; // 24 hours
const STREAM_EMPTY_TTL = 60 * 1000; // 1 minute
const RESOLVED_URL_TTL = 3 * 60 * 60 * 1000; // 3 hours
const AVAILABILITY_TTL =  5 * 24 * 60 * 60 * 1000; // 5 days
const MESSAGE_VIDEO_URL_TTL = 60 * 1000; // 1 minutes

const MONGO_URI = process.env.MONGODB_URI;
const REDIS_URL = process.env.REDIS_URL;

const memoryCache = new KeyvCacheableMemory({ ttl: MESSAGE_VIDEO_URL_TTL, lruSize: Infinity });
const redisCache = REDIS_URL && new KeyvRedis(REDIS_URL);
const mongoCache = MONGO_URI && new KeyvMongo(MONGO_URI, {
  collection: 'torrentio_addon_collection',
  minPoolSize: 50,
  maxPoolSize: 200,
  maxConnecting: 5,
});

async function cacheWrapRedis(key, method, ttl) {
    const value = await redisCache.get(key);
    if (value !== undefined) {
        try {
            return JSON.parse(value);
        } catch (e) {
            console.warn(`Cache parse error for key ${key}`, e);
        }
    }
    const result = await method();
    const ttlValue = ttl instanceof Function ? ttl(result) : ttl;
    await redisCache.set(key, JSON.stringify(result), ttlValue);
    return result;
}

export function cacheWrapStream(id, method) {
  const ttl = (streams) => streams.length ? STREAM_TTL : STREAM_EMPTY_TTL;
  return cacheWrapRedis(`${STREAM_KEY_PREFIX}:${id}`, method, ttl);
}

export function cacheWrapResolvedUrl(id, method) {
  const ttl = (url) => isStaticUrl(url) ? MESSAGE_VIDEO_URL_TTL : RESOLVED_URL_TTL;
  return cacheWrapRedis(`${RESOLVED_URL_KEY_PREFIX}:${id}`, method, ttl);
}

export function cacheAvailabilityResults(infoHash, fileIds) {
  const key = `${AVAILABILITY_KEY_PREFIX}:${infoHash}`;
  const fileIdsString = fileIds.toString();
  const containsFileIds = (array) => array.some(ids => ids.toString() === fileIdsString)
  return mongoCache.get(key)
      .then(result => {
        const newResult = result || [];
        if (!containsFileIds(newResult)) {
          newResult.push(fileIds);
          newResult.sort((a, b) => b.length - a.length);
        }
        return mongoCache.set(key, newResult, AVAILABILITY_TTL);
      });
}

export function removeAvailabilityResults(infoHash, fileIds) {
  const key = `${AVAILABILITY_KEY_PREFIX}:${infoHash}`;
  const fileIdsString = fileIds.toString();
  return mongoCache.get(key)
      .then(result => {
        const storedIndex = result?.findIndex(ids => ids.toString() === fileIdsString);
        if (storedIndex >= 0) {
          result.splice(storedIndex, 1);
          return mongoCache.set(key, result, AVAILABILITY_TTL);
        }
      });
}

export function getCachedAvailabilityResults(infoHashes) {
  const keys = infoHashes.map(infoHash => `${AVAILABILITY_KEY_PREFIX}:${infoHash}`)
  return mongoCache.getMany(keys)
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

export function cacheMochAvailabilityResult(moch, infoHash, result = { cached: true }) {
    const key = `${AVAILABILITY_KEY_PREFIX}:${moch}:${infoHash}`;
    return mongoCache.set(key, result, AVAILABILITY_TTL);
}

export function removeMochAvailabilityResult(moch, infoHash) {
    const key = `${AVAILABILITY_KEY_PREFIX}:${moch}:${infoHash}`;
    return mongoCache.delete(key);
}

export function getMochCachedAvailabilityResults(moch, infoHashes) {
    const keys = infoHashes.map(infoHash => `${AVAILABILITY_KEY_PREFIX}:${moch}:${infoHash}`)
    return mongoCache.getMany(keys)
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
