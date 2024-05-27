import Bottleneck from 'bottleneck';
import moment from 'moment';
import { addonBuilder } from 'stremio-addon-sdk';
import { Providers } from '../addon/lib/filter.js';
import { createManifest, genres } from './lib/manifest.js';
import { getMetas } from './lib/metadata.js';
import { cacheWrapCatalog, cacheWrapIds } from './lib/cache.js';
import * as repository from './lib/repository.js';

const CACHE_MAX_AGE = parseInt(process.env.CACHE_MAX_AGE) || 4 * 60 * 60; // 4 hours in seconds
const STALE_REVALIDATE_AGE = 4 * 60 * 60; // 4 hours
const STALE_ERROR_AGE = 7 * 24 * 60 * 60; // 7 days

const manifest = createManifest();
const builder = new addonBuilder(manifest);
const limiter = new Bottleneck({
  maxConcurrent: process.env.LIMIT_MAX_CONCURRENT || 20,
  highWater: process.env.LIMIT_QUEUE_SIZE || 50,
  strategy: Bottleneck.strategy.OVERFLOW
});
const defaultProviders = Providers.options
    .filter(provider => !provider.foreign)
    .map(provider => provider.label)
    .sort();

builder.defineCatalogHandler((args) => {
  const offset = parseInt(args.extra.skip || '0', 10);
  const genre = args.extra.genre || 'default';
  const catalog = manifest.catalogs.find(c => c.id === args.id);
  const providers = defaultProviders;
  console.log(`Incoming catalog ${args.id} request with genre=${genre} and skip=${offset}`);
  if (!catalog) {
    return Promise.reject(`No catalog found for with id: ${args.id}`);
  }

  const cacheKey = createCacheKey(catalog.id, providers, genre, offset);
  return limiter.schedule(() => cacheWrapCatalog(cacheKey, () => getCatalog(catalog, providers, genre, offset)))
      .then(metas => ({
        metas: metas,
        cacheMaxAge: CACHE_MAX_AGE,
        staleRevalidate: STALE_REVALIDATE_AGE,
        staleError: STALE_ERROR_AGE
      }))
      .catch(error => Promise.reject(`Failed retrieving catalog ${args.id}: ${error.message}`));
})

async function getCursor(catalog, providers, genre, offset) {
  if (offset === 0) {
    return undefined;
  }
  const previousOffset = offset - catalog.pageSize;
  const previousCacheKey = createCacheKey(catalog.id, providers, genre, previousOffset);
  return cacheWrapCatalog(previousCacheKey, () => Promise.reject("cursor not found"))
      .then(metas => metas[metas.length - 1])
      .then(meta => meta.id.replace('kitsu:', ''))
}

async function getCatalog(catalog, providers, genre, offset) {
  const cursor = await getCursor(catalog, providers, genre, offset)
  const startDate = getStartDate(genre)?.toISOString();
  const endDate = getEndDate(genre)?.toISOString();
  const cacheKey = createCacheKey(catalog.id, providers, genre);

  return cacheWrapIds(cacheKey, () => repository.getIds(providers, catalog.type, startDate, endDate))
      .then(ids => ids.slice(ids.indexOf(cursor) + 1))
      .then(ids => getMetas(ids, catalog.type))
      .then(metas => metas.slice(0, catalog.pageSize));
}

function getStartDate(genre) {
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

function getEndDate(genre) {
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

function createCacheKey(catalogId, providers, genre, offset) {
  const dateKey = moment().format('YYYY-MM-DD');
  return [catalogId, providers.join(','), genre, dateKey, offset].filter(x => x !== undefined).join('|');
}

export default builder.getInterface();
