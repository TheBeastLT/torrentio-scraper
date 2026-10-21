import { KeyvCacheableMemory } from "cacheable";
import { isStaticUrl }  from '../moch/static.js';
import { timeout } from './promises.js';
import { cacheTimer, cacheResult } from './metrics.js';
import { availableMemoryBytes } from "./requestHelper.js";
import { createMongoClient, createMongoStore } from "./mongoStore.js";

const CACHE_READ_TIMEOUT = 3 * 1000;

const GLOBAL_KEY_PREFIX = 'torrentio-addon';
const STREAM_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|stream`;
const AVAILABILITY_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|availability`;
const RESOLVED_URL_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|resolved`;

const STREAM_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days
const STREAM_MEM_TTL = 2 * 60 * 60 * 1000; // 2 hours
const STREAM_EMPTY_TTL = 60 * 1000; // 1 minute
const RESOLVED_URL_TTL = 3 * 60 * 60 * 1000; // 3 hours
const AVAILABILITY_TTL =  14 * 24 * 60 * 60 * 1000; // 14 days
const INFRINGING_TTL =  60 * 24 * 60 * 60 * 1000; // 60 days
const MESSAGE_VIDEO_URL_TTL = 60 * 1000; // 1 minutes

const MONGO_URI = process.env.MONGODB_URI;

const STREAM_ENTRY_BYTES = 40 * 1024;
const STREAM_MEM_FRACTION = Number(process.env.CACHE_MEM_FRACTION) || 0.25;
const availableMem = availableMemoryBytes();
const streamLruSize = Number(process.env.STREAM_LRU_SIZE)
    || Math.min(15000, Math.max(5000, Math.floor(availableMem * STREAM_MEM_FRACTION / STREAM_ENTRY_BYTES)));

const streamMemoryCache = new KeyvCacheableMemory({ lruSize: streamLruSize });
const resolvedMemoryCache = new KeyvCacheableMemory({ lruSize: 20000 });
console.log(`Cache LRU sizes: stream=${streamLruSize} resolved=20000 (availMem=${(availableMem / 1024 ** 3).toFixed(1)}GB)`);
const mongoClient = MONGO_URI && createMongoClient(MONGO_URI);
const streamStore = mongoClient && createMongoStore(mongoClient, 'torrentio_addon_stream', { compressValues: true });
const availabilityStore = mongoClient && createMongoStore(mongoClient, 'torrentio_addon_availability');

async function cacheWrap(name, key, method, ttl, memCache, store) {
    let value = await cacheGet(memCache, key);
    if (value !== undefined) {
        cacheResult(name, 'memory');
        return value;
    }
    if (store) {
        const storeEnd = cacheTimer('get');
        value = await cacheGet(store, key, true);
        storeEnd();
        if (value !== undefined) {
            cacheResult(name, 'store');
            cacheSet(memCache, key, value, ttl);
            return value;
        }
    }
    cacheResult(name, 'miss');
    const result = await method();
    if (store) {
        cacheSet(store, key, result, ttl);
    }
    cacheSet(memCache, key, result, ttl);
    return result;
}

async function cacheGet(cache, key, withTimeout = false) {
    const get = withTimeout ? timeout(CACHE_READ_TIMEOUT, cache.get(key)) : cache.get(key);
    return Promise.resolve(get).catch(() => undefined);
}

function cacheSet(cache, key, value, ttl) {
    cacheValue(cache, key, value, ttl).catch(logWriteError(key));
}

function logWriteError(key) {
    return error => console.warn('Failed to write cache', key, error?.message || error);
}

async function cacheValue(cache, key, value, ttl) {
    const ttlValue = ttl instanceof Function ? ttl(value, cache) : ttl;
    await cache.set(key, value, ttlValue);
}

export function closeCache() {
  return mongoClient ? mongoClient.close() : Promise.resolve();
}

export function cacheWrapStream(id, method) {
  const ttl = (streams, cache) => streams.length ? cache !== streamMemoryCache ? STREAM_TTL : STREAM_MEM_TTL : STREAM_EMPTY_TTL;
  return cacheWrap('stream', `${STREAM_KEY_PREFIX}:${id}`, method, ttl, streamMemoryCache, streamStore);
}

export function cacheWrapResolvedUrl(id, method) {
  const ttl = (url) => isStaticUrl(url) ? MESSAGE_VIDEO_URL_TTL : RESOLVED_URL_TTL;
  return cacheWrap('resolved', `${RESOLVED_URL_KEY_PREFIX}:${id}`, method, ttl, resolvedMemoryCache);
}

export function cacheAvailabilityResults(infoHash, fileIds) {
  const key = `${AVAILABILITY_KEY_PREFIX}:${infoHash}`;
  const fileIdsString = fileIds.toString();
  const containsFileIds = (array) => array.some(ids => ids.toString() === fileIdsString)
  return availabilityStore.get(key)
      .then(result => {
        const newResult = Array.isArray(result) ? result : [];
        if (!containsFileIds(newResult)) {
          newResult.push(fileIds);
          newResult.sort((a, b) => b.length - a.length);
        }
        return availabilityStore.set(key, newResult, AVAILABILITY_TTL);
      })
      .catch(logWriteError(key));
}

export function removeAvailabilityResults(infoHash, fileIds) {
  const key = `${AVAILABILITY_KEY_PREFIX}:${infoHash}`;
  if (fileIds === undefined) {
      return availabilityStore.delete(key).catch(logWriteError(key));
  }
  const fileIdsString = fileIds.toString();
  return availabilityStore.get(key)
      .then(result => {
        const storedIndex = Array.isArray(result) ? result.findIndex(ids => ids.toString() === fileIdsString) : -1;
        if (storedIndex >= 0) {
          result.splice(storedIndex, 1);
          return availabilityStore.set(key, result, AVAILABILITY_TTL);
        }
      })
      .catch(logWriteError(key));
}

export function getCachedAvailabilityResults(infoHashes) {
  const keys = infoHashes.map(infoHash => `${AVAILABILITY_KEY_PREFIX}:${infoHash}`)
  const end = cacheTimer('getMany');
  return availabilityStore.getMany(keys)
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

export function cacheInfringingResult(infoHash) {
  const key = `${AVAILABILITY_KEY_PREFIX}:${infoHash}`;
  return availabilityStore.set(key, { infringing: true }, INFRINGING_TTL).catch(logWriteError(key));
}

export function cacheMochAvailabilityResult(moch, infoHash, result = { cached: true }) {
    const key = `${AVAILABILITY_KEY_PREFIX}:${moch}:${infoHash}`;
    return availabilityStore.set(key, result, AVAILABILITY_TTL).catch(logWriteError(key));
}

export function removeMochAvailabilityResult(moch, infoHash) {
    const key = `${AVAILABILITY_KEY_PREFIX}:${moch}:${infoHash}`;
    return availabilityStore.delete(key).catch(logWriteError(key));
}

export function getMochCachedAvailabilityResults(moch, infoHashes) {
    const keys = infoHashes.map(infoHash => `${AVAILABILITY_KEY_PREFIX}:${moch}:${infoHash}`)
    const end = cacheTimer('getMany');
    return availabilityStore.getMany(keys)
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
