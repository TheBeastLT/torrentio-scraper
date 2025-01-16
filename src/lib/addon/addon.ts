import { addonBuilder, Stream } from 'stremio-addon-sdk';
import { Type } from './lib/types.js';
import { dummyManifest } from './lib/manifest.js';
import { cacheWrapStream } from './lib/cache.js';
import { toStreamInfo, applyStaticInfo } from './lib/streamInfo.js';
import * as repository from './lib/repository.js';
import applySorting from './lib/sort.js';
import applyFilters from './lib/filter.js';
import { applyMochs, getMochCatalog, getMochItemMeta } from './moch/moch.js';
import StaticLinks from './moch/static.js';
import { createNamedQueue } from "./lib/namedQueue.js";
import pLimit from "p-limit";

function getMaxAge() {
  const maxAgeEnv = process.env.CACHE_MAX_AGE;
  if (maxAgeEnv) {
    return parseInt(maxAgeEnv);
  }

  return 60 * 60;
}

const CACHE_MAX_AGE = getMaxAge(); // 1 hour in seconds
const CACHE_MAX_AGE_EMPTY = 60; // 60 seconds
const CATALOG_CACHE_MAX_AGE = 0; // 0 minutes
const STALE_REVALIDATE_AGE = 4 * 60 * 60; // 4 hours
const STALE_ERROR_AGE = 7 * 24 * 60 * 60; // 7 days

const builder = new addonBuilder(dummyManifest());
const requestQueue = createNamedQueue(Infinity);
const newLimiter = pLimit(30)

builder.defineStreamHandler((args) => {
  if (!args.id.match(/tt\d+/i) && !args.id.match(/kitsu:\d+/i)) {
    return Promise.resolve({ streams: [] });
  }

  return requestQueue.wrap(args.id, () => resolveStreams(args))
    .then((streams: Stream[]) => applyFilters(streams, args.extra))
    .then((streams: Stream[]) => applySorting(streams, args.extra, args.type))
    .then((streams: Stream[]) => applyStaticInfo(streams))
    .then((streams: Stream[]) => applyMochs(streams, args.extra))
    .then((streams: Stream[]) => enrichCacheParams(streams))
    .catch((error: unknown) => {
      return Promise.reject(`Failed request ${args.id}: ${error}`);
    });
});

builder.defineCatalogHandler((args) => {
  const [_, mochKey, catalogId] = args.id.split('-');
  console.log(`Incoming catalog ${args.id} request with skip=${args.extra.skip || 0}`)
  return getMochCatalog(mochKey, catalogId, args.extra)
    .then(metas => ({
      metas: metas,
      cacheMaxAge: CATALOG_CACHE_MAX_AGE
    }))
    .catch(error => {
      return Promise.reject(`Failed retrieving catalog ${args.id}: ${JSON.stringify(error.message || error)}`);
    });
})

builder.defineMetaHandler((args) => {
  const [mochKey, metaId] = args.id.split(':');
  console.log(`Incoming debrid meta ${args.id} request`)
  return getMochItemMeta(mochKey, metaId, args.extra)
    .then(meta => ({
      meta: meta,
      cacheMaxAge: metaId === 'Downloads' ? 0 : CACHE_MAX_AGE
    }))
    .catch(error => {
      return Promise.reject(`Failed retrieving catalog meta ${args.id}: ${JSON.stringify(error)}`);
    });
})

async function resolveStreams(args) {
  return cacheWrapStream(args.id, () => newLimiter(() => streamHandler(args)
    .then(records => records
      .sort((a, b) => b.torrent.seeders - a.torrent.seeders || b.torrent.uploadDate - a.torrent.uploadDate)
      .map(record => toStreamInfo(record)))));
}

async function streamHandler(args) {
  // console.log(`Pending count: ${newLimiter.pendingCount}, active count: ${newLimiter.activeCount}`, )
  if (args.type === Type.MOVIE) {
    return movieRecordsHandler(args);
  } else if (args.type === Type.SERIES) {
    return seriesRecordsHandler(args);
  }
  return Promise.reject('not supported type');
}

async function seriesRecordsHandler(args) {
  if (args.id.match(/^tt\d+:\d+:\d+$/)) {
    const parts = args.id.split(':');
    const imdbId = parts[0];
    const season = parts[1] !== undefined ? parseInt(parts[1], 10) : 1;
    const episode = parts[2] !== undefined ? parseInt(parts[2], 10) : 1;
    return repository.getImdbIdSeriesEntries(imdbId, season, episode);
  } else if (args.id.match(/^kitsu:\d+(?::\d+)?$/i)) {
    const parts = args.id.split(':');
    const kitsuId = parts[1];
    const episode = parts[2] !== undefined ? parseInt(parts[2], 10) : undefined;
    return episode !== undefined
      ? repository.getKitsuIdSeriesEntries(kitsuId, episode)
      : repository.getKitsuIdMovieEntries(kitsuId);
  }
  return Promise.resolve([]);
}

async function movieRecordsHandler(args) {
  if (args.id.match(/^tt\d+$/)) {
    const parts = args.id.split(':');
    const imdbId = parts[0];
    return repository.getImdbIdMovieEntries(imdbId);
  } else if (args.id.match(/^kitsu:\d+(?::\d+)?$/i)) {
    return seriesRecordsHandler(args);
  }
  return Promise.resolve([]);
}

function enrichCacheParams(streams) {
  let cacheAge = CACHE_MAX_AGE;
  if (!streams.length) {
    cacheAge = CACHE_MAX_AGE_EMPTY;
  } else if (streams.every(stream => stream?.url?.endsWith(StaticLinks.FAILED_ACCESS))) {
    cacheAge = 0;
  }
  return {
    streams: streams,
    cacheMaxAge: cacheAge,
    staleRevalidate: STALE_REVALIDATE_AGE,
    staleError: STALE_ERROR_AGE
  }
}

export default builder.getInterface();
