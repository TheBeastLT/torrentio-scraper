const Bottleneck = require('bottleneck');
const moment = require('moment')
const { addonBuilder } = require('stremio-addon-sdk');
const { createManifest, genres } = require('./lib/manifest');
const { getMetas } = require('./lib/metadata');
const { cacheWrapCatalog, cacheWrapIds } = require('./lib/cache');
const repository = require('./lib/repository');

const CACHE_MAX_AGE = process.env.CACHE_MAX_AGE || 4 * 60 * 60; // 4 hours in seconds
const STALE_REVALIDATE_AGE = 4 * 60 * 60; // 4 hours
const STALE_ERROR_AGE = 7 * 24 * 60 * 60; // 7 days

const manifest = createManifest();
const builder = new addonBuilder(manifest);
const limiter = new Bottleneck({
  maxConcurrent: process.env.LIMIT_MAX_CONCURRENT || 20,
  highWater: process.env.LIMIT_QUEUE_SIZE || 50,
  strategy: Bottleneck.strategy.OVERFLOW
});


builder.defineCatalogHandler((args) => {
  const offset = parseInt(args.extra.skip || '0', 10);
  const genre = args.extra.genre || 'default';
  const catalog = manifest.catalogs.find(c => c.id === args.id);
  console.log(`Incoming catalog ${args.id} request with genre=${genre} and skip=${offset}`)
  if (!catalog) {
    return Promise.reject(`No catalog found for with id: ${args.id}`)
  }

  const cacheKey = `${args.id}|${genre}|${offset}`
  return limiter.schedule(() => cacheWrapCatalog(cacheKey, () => getCatalog(catalog, genre, offset)))
      .then(metas => ({
        metas: metas,
        cacheMaxAge: CACHE_MAX_AGE,
        staleRevalidate: STALE_REVALIDATE_AGE,
        staleError: STALE_ERROR_AGE
      }))
      .catch(error => Promise.reject(`Failed retrieving catalog ${args.id}: ${JSON.stringify(error)}`));
})

async function getCursor(catalog, genre, offset) {
  if (offset === 0) {
    return undefined;
  }
  const previousCacheKey = `${catalog.id}|${genre}|${dateKey()}|${offset - catalog.pageSize}`;
  return cacheWrapCatalog(previousCacheKey, () => Promise.reject("cursor not found"))
      .then(metas => metas[metas.length - 1])
      .then(meta => meta.id.replace('kitsu:', ''))
}

async function getCatalog(catalog, genre, offset) {
  const cursor = await getCursor(catalog, genre, offset)
  const startDate = getStartDate(genre)?.toISOString();
  const endDate = getEndDate(genre)?.toISOString();
  const cacheKey = `${catalog.id}|${genre}||${dateKey()}`

  return cacheWrapIds(cacheKey, () => repository.getIds(catalog.type, startDate, endDate))
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
    default: return moment().utc().subtract(1, 'day').endOf('day');
  }
}

function dateKey() {
  return moment().format('YYYY-MM-DD')
}

module.exports = builder.getInterface();
