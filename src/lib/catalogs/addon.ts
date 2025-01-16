import Bottleneck from 'bottleneck';
import moment from 'moment';
import { addonBuilder, Manifest, ManifestCatalog } from 'stremio-addon-sdk';
import { Providers } from '../addon/lib/filter.js';
import { createManifest, genres } from './lib/manifest.js';
import { getMetas } from './lib/metadata.js';
import { cacheWrapCatalog, cacheWrapIds } from './lib/cache.js';
import * as repository from './lib/repository.js';
import { getCacheMaxAge } from '../addon/lib/cache.js'

const CACHE_MAX_AGE = getCacheMaxAge(); // 4 hours in seconds
const STALE_REVALIDATE_AGE = 4 * 60 * 60; // 4 hours
const STALE_ERROR_AGE = 7 * 24 * 60 * 60; // 7 days

/**
 * Returns the max concurrency for the Bottleneck limiter.
 * This is the max number of concurrent requests that the limiter will allow.
 * If the LIMIT_MAX_CONCURRENT environment variable is set, it will be used.
 * Otherwise, the default value is 20.
 * @returns {number} The max concurrency.
 */
function getConcurrency(): number {
  const val = process.env.LIMIT_MAX_CONCURRENT;

  if (val) {
    return parseInt(val, 10);
  }

  return 20;
}

/**
 * Returns the queue size for the Bottleneck limiter.
 * Defaults to 50 if LIMIT_QUEUE_SIZE environment variable is not set.
 * @returns {number} The queue size.
 */
function getQueueSize(): number {
  const val = process.env.LIMIT_QUEUE_SIZE;

  if (val) {
    return parseInt(val, 10);
  }

  return 50;
}

interface ICreateCacheKey {
  catalogId: string;
  providers: string[];
  genre: string;
  offset: number
}

/**
 * Creates a unique cache key for a given catalog and its options.
 * @param {ICreateCacheKey} params - The id of the catalog.
 * @param {string} params.catalogId - The id of the catalog.
 * @param {MediaProvider[]} params.providers - The list of providers.
 * @param {string} params.genre - The genre or category of the catalog.
 * @param {number} params.offset - The offset of the current page.
 * @returns {string} A unique cache key.
 */
function createCacheKey({
  catalogId,
  providers,
  genre,
  offset
}: ICreateCacheKey): string {
  const dateKey = moment().format('YYYY-MM-DD');
  return [catalogId, providers.join(','), genre, dateKey, offset].filter(x => x !== undefined).join('|');
}

const manifest: Manifest = createManifest();
const builder = new addonBuilder(manifest);
const limiter = new Bottleneck({
  maxConcurrent: getConcurrency(),
  highWater: getQueueSize(),
  strategy: Bottleneck.strategy.OVERFLOW
});
const defaultProviders = Providers.options
  .filter(provider => !provider.foreign)
  .map(provider => provider.label)
  .sort();

interface IGetCatalog {
  catalog: ManifestCatalog;
  providers: string[];
  genre: string;
  offset: number;
}

/**
 * Retrieves the cursor for a given catalog, providers, genre, and offset.
 * The cursor is used to track the last item retrieved from the previous page.
 * Returns undefined if the offset is 0, indicating the first page.
 *
 * @param {Catalog} catalog - The catalog to retrieve the cursor for.
 * @param {MediaProvider[]} providers - The list of media providers.
 * @param {string} genre - The genre or category.
 * @param {number} offset - The offset of the current page.
 * @returns {Promise<string | undefined>} A promise resolving to the cursor ID or undefined.
 */
function getCursor({ catalog, providers, genre, offset }: IGetCatalog) {
  if (offset === 0) {
    return undefined;
  }
  const previousCacheKey = createCacheKey({
    catalogId: catalog.id,
    providers,
    genre,
    offset
  });
  return cacheWrapCatalog({
    key: previousCacheKey,
    method: () => Promise.reject(new Error("cursor not found"))
  })
    .then((metas) => metas[metas.length - 1])
    .then((meta) => meta.id.replace('kitsu:', ''))
}



/**
 * Returns the start date of a given genre or category.
 * @param {string} genre - The genre or category.
 * @returns {moment.Moment | undefined} The start date of the given genre or undefined if not found.
 */
function getStartDate(genre: string): moment.Moment | undefined {
  switch (genre) {
    case genres[0]: return moment().utc().subtract(1, 'day').startOf('day');
    case genres[1]: return moment().utc().startOf('isoWeek');
    case genres[2]: return moment().utc().subtract(7, 'day').startOf('isoWeek');
    case genres[3]: return moment().utc().startOf('month');
    case genres[4]: return moment().utc().subtract(30, 'day').startOf('month');
    case genres[5]: return undefined;
    default: return moment().utc().subtract(30, 'day').startOf('day');
  }
}

/**
 * Returns the end date of a given genre or category.
 * @param {string} genre - The genre or category.
 * @returns {moment.Moment | undefined} The end date of the given genre or undefined if not found.
 */

function getEndDate(genre: string): moment.Moment | undefined {
  switch (genre) {
    case genres[0]: return moment().utc().subtract(1, 'day').endOf('day');
    case genres[1]: return moment().utc().endOf('isoWeek');
    case genres[2]: return moment().utc().subtract(7, 'day').endOf('isoWeek');
    case genres[3]: return moment().utc().endOf('month');
    case genres[4]: return moment().utc().subtract(30, 'day').endOf('month');
    case genres[5]: return undefined;
    default: return moment().utc().subtract(1, 'day').endOf('day');
  }
}




/**
 * Retrieves a page of metas for a given catalog and genre.
 * @param {Catalog} catalog - The catalog to retrieve.
 * @param {MediaProvider[]} providers - The list of providers.
 * @param {string} genre - The genre or category.
 * @param {number} offset - The offset of the current page.
 * @returns {Promise<Stream[]>} A promise resolving to an array of Stream objects.
 */
async function getCatalog({
  catalog,
  providers,
  genre,
  offset
}: IGetCatalog): Promise<string[]> {
  const cursor = await getCursor({
    catalog,
    providers,
    genre,
    offset
  });

  const startDate = getStartDate(genre)?.toISOString();
  const endDate = getEndDate(genre)?.toISOString();

  const cacheKey = createCacheKey({
    catalogId: catalog.id,
    providers,
    genre,
    offset
  });

  return cacheWrapIds({
    key: cacheKey,
    method: () => repository.getIds(providers, catalog.type, startDate, endDate)
  })
    .then((ids) => ids.slice(ids.indexOf(cursor) + 1))
    .then((ids) => getMetas(ids, catalog.type));
}

builder.defineCatalogHandler(async (args) => {
  const offset = parseInt(args.extra.skip.toString() || '0', 10);
  const genre = args.extra.genre || 'default';
  const catalog = manifest.catalogs.find(c => c.id === args.id);
  const providers = defaultProviders;

  console.log(`Incoming catalog ${args.id} request with genre=${genre} and skip=${offset}`);

  if (!catalog) {
    return Promise.reject(new Error(`No catalog found for with id: ${args.id}`));
  }

  const cacheKey = createCacheKey({
    catalogId: catalog.id,
    providers,
    genre,
    offset
  });


  try {
    const metas = await limiter.schedule(() => cacheWrapCatalog({
      key: cacheKey,
      method: () => getCatalog({
        catalog,
        providers,
        genre,
        offset
      })
    }));

    return ({
      metas,
      cacheMaxAge: CACHE_MAX_AGE,
      staleRevalidate: STALE_REVALIDATE_AGE,
      staleError: STALE_ERROR_AGE
    });

  } catch (error) {
    if (error instanceof Error) {
      return await Promise.reject(new Error(`Failed retrieving catalog ${args.id}: ${error.message}`));
    }

    return await Promise.reject(new Error(`Failed retrieving catalog ${args.id}: ${error}`));
  }
})



export default builder.getInterface();
