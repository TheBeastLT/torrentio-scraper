import KeyvMongo from "@keyv/mongo";

const CATALOG_TTL = 24 * 60 * 60 * 1000; // 24 hours

const MONGO_URI = process.env.MONGODB_URI;

/**
 * Returns the remote cache instance.
 * If the MONGO_URI environment variable is not set, will return undefined.
 * @returns {KeyvMongo | undefined}
 */
function getRemoteCache(): KeyvMongo | undefined {
  if (MONGO_URI) {
    return new KeyvMongo(MONGO_URI, { collection: 'torrentio_catalog_collection' });
  }
}

type Method = () => Promise<string[]>;

interface ICacheWrap {
  key: string;
  method: Method;
  ttl: number;
}

/**
 * Wraps a method with caching. If the cache is not set up, will simply call the method.
 * Otherwise, will check the cache for the given key. If the key is not present, will call the method,
 * cache the result, and return it. If the key is present, will return the cached value.
 *
 * @param {ICacheWrap} - An object with the following properties:
 *  - key: The key to use for caching.
 *  - method: The method to call if the cache doesn't have the key.
 *  - ttl: The time to live for the cache entry.
 * @returns {Promise<Stream[]>} The cached or newly retrieved value.
 */
async function cacheWrap({ key, method, ttl }: ICacheWrap): Promise<string[]> {
  const cache = getRemoteCache();

  if (!cache) {
    return method();
  }

  const value = await cache.get(key);
  if (value !== undefined) {
    return value;
  }

  const result = await method();

  await cache.set(key, result, ttl);

  return method();
}

/**
 * Wraps a method with caching. If the cache is not set up, will simply call the method.
 * Otherwise, will check the cache for the given key. If the key is not present, will call the method,
 * cache the result, and return it. If the key is present, will return the cached value.
 *
 * @param {string} key - The key to use for caching.
 * @param {Method} method - The method to call if the cache doesn't have the key.
 * @returns {Promise<Stream[]>} The cached or newly retrieved value.
 */
export function cacheWrapCatalog({ key, method }: {
  key: string;
  method: Method;
}): Promise<string[]> {
  return cacheWrap({
    key,
    method,
    ttl: CATALOG_TTL
  });
}

/**
 * Wraps a method with caching, like cacheWrapCatalog, but prefixes the cache key with 'ids|'.
 * This is used to cache the list of IDs for a given catalog, so that we can avoid calling the
 * repository's getIds method over and over again.
 *
 * @param {string} key - The key to use for caching.
 * @param {Method} method - The method to call if the cache doesn't have the key.
 * @returns {Promise<Stream[]>} The cached or newly retrieved value.
 */
export function cacheWrapIds({ key, method }: {
  key: string;
  method: Method;
}): Promise<string[]> {

  return cacheWrap({
    key: `ids|${key}`,
    method,
    ttl: CATALOG_TTL
  });
}
