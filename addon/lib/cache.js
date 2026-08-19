import KeyvMongo from "@keyv/mongo";
import { KeyvCacheableMemory } from "cacheable";
import { isStaticUrl }  from '../moch/static.js';
import { timeout } from './promises.js';
import { cacheTimer, cacheResult } from './metrics.js';
import { availableMemoryBytes } from "./requestHelper.js";

const CACHE_READ_TIMEOUT = 3 * 1000;

const GLOBAL_KEY_PREFIX = 'torrentio-addon';
const STREAM_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|stream`;
const AVAILABILITY_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|availability`;
const RESOLVED_URL_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|resolved`;

const STREAM_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days
const STREAM_MEM_TTL = 2 * 60 * 60 * 1000; // 2 hours
const STREAM_EMPTY_TTL = 60 * 1000; // 1 minute
const RESOLVED_URL_TTL = 3 * 60 * 60 * 1000; // 3 hours
const AVAILABILITY_TTL =  5 * 24 * 60 * 60 * 1000; // 5 days
const MESSAGE_VIDEO_URL_TTL = 60 * 1000; // 1 minutes

const MONGO_URI = process.env.MONGODB_URI;

const STREAM_ENTRY_BYTES = 40 * 1024;
const STREAM_MEM_FRACTION = Number(process.env.CACHE_MEM_FRACTION) || 0.25;
const availableMem = availableMemoryBytes();
const streamLruSize = Number(process.env.STREAM_LRU_SIZE)
    || Math.min(50000, Math.max(5000, Math.floor(availableMem * STREAM_MEM_FRACTION / STREAM_ENTRY_BYTES)));

const streamMemoryCache = new KeyvCacheableMemory({ lruSize: streamLruSize });
const resolvedMemoryCache = new KeyvCacheableMemory({ lruSize: 20000 });
const memoryCache = new KeyvCacheableMemory({ lruSize: 10000 });
console.log(`Cache LRU sizes: stream=${streamLruSize} resolved=20000 memory=10000 (availMem=${(availableMem / 1024 ** 3).toFixed(1)}GB)`);
const mongoCache = MONGO_URI && new KeyvMongo(MONGO_URI, {
  collection: 'torrentio_addon_collection',
  minPoolSize: 50,
  maxPoolSize: 200,
  maxConnecting: 5,
});

async function cacheWrap(name, key, method, ttl, memCache = memoryCache) {
    if (!mongoCache) {
        return method();
    }
    let value = await cacheGet(memCache, key);
    if (value !== undefined) {
        cacheResult(name, 'memory');
        return value;
    }
    const mongoEnd = cacheTimer('get');
    value = await cacheGet(mongoCache, key, true);
    mongoEnd();
    if (value !== undefined) {
        cacheResult(name, 'store');
        cacheSet(memCache, key, value, ttl);
        return value;
    }
    cacheResult(name, 'miss');
    const result = await method();
    cacheSet(mongoCache, key, result, ttl);
    cacheSet(memCache, key, result, ttl);
    return result;
}

async function cacheGet(cache, key, withTimeout = false) {
    const get = withTimeout ? timeout(CACHE_READ_TIMEOUT, cache.get(key)) : cache.get(key);
    return Promise.resolve(get).catch(() => undefined);
}

function cacheSet(cache, key, value, ttl) {
    cacheValue(cache, key, value, ttl).catch(error => console.warn('Failed to write cache', key, error?.message || error));
}

async function cacheValue(cache, key, value, ttl) {
    const ttlValue = ttl instanceof Function ? ttl(value, cache) : ttl;
    await cache.set(key, value, ttlValue);
}

export function closeCache() {
  return mongoCache ? mongoCache.disconnect() : Promise.resolve();
}

export function cacheWrapStream(id, method) {
  const ttl = (streams, cache) => streams.length ? cache !== streamMemoryCache ? STREAM_TTL : STREAM_MEM_TTL : STREAM_EMPTY_TTL;
  return cacheWrap('stream', `${STREAM_KEY_PREFIX}:${id}`, method, ttl, streamMemoryCache);
}

export function cacheWrapResolvedUrl(id, method) {
  const ttl = (url) => isStaticUrl(url) ? MESSAGE_VIDEO_URL_TTL : RESOLVED_URL_TTL;
  return cacheWrap('resolved', `${RESOLVED_URL_KEY_PREFIX}:${id}`, method, ttl, resolvedMemoryCache);
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
  if (fileIds === undefined) {
      return mongoCache.delete(key);
  }
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
  const end = cacheTimer('getMany');
  return mongoCache.getMany(keys)
      .then(result => {
        end();
        const availabilityResults = {};
        infoHashes.forEach((infoHash, index) => {
          if (result[index]) {
            availabilityResults[infoHash] = result[index];
          }
        });
        return availabilityResults;
      })
      .catch(error => {
        end();
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
    const end = cacheTimer('getMany');
    return mongoCache.getMany(keys)
        .then(result => {
            end();
            const availabilityResults = {};
            infoHashes.forEach((infoHash, index) => {
                if (result[index]) {
                    availabilityResults[infoHash] = result[index];
                }
            });
            return availabilityResults;
        })
        .catch(error => {
            end();
            console.log('Failed retrieve availability cache', error)
            return {};
        });
}
