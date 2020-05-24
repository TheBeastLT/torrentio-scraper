const Bottleneck = require('bottleneck');
const { addonBuilder } = require('stremio-addon-sdk');
const { Type } = require('./lib/types');
const { manifest, DefaultProviders } = require('./lib/manifest');
const { cacheWrapStream } = require('./lib/cache');
const { toStreamInfo } = require('./lib/streamInfo');
const repository = require('./lib/repository');
const applySorting = require('./lib/sort');
const { applyMochs } = require('./moch/moch');

const CACHE_MAX_AGE = process.env.CACHE_MAX_AGE || 4 * 60 * 60; // 4 hours in seconds
const CACHE_MAX_AGE_EMPTY = 30 * 60; // 30 minutes
const STALE_REVALIDATE_AGE = 4 * 60 * 60; // 4 hours
const STALE_ERROR_AGE = 7 * 24 * 60 * 60; // 7 days

const defaultProviders = DefaultProviders.map(provider => provider.toLowerCase());
const builder = new addonBuilder(manifest());
const limiter = new Bottleneck({
  maxConcurrent: process.env.LIMIT_MAX_CONCURRENT || 20,
  highWater: process.env.LIMIT_QUEUE_SIZE || 100,
  strategy: Bottleneck.strategy.OVERFLOW
});

builder.defineStreamHandler((args) => {
  if (!args.id.match(/tt\d+/i) && !args.id.match(/kitsu:\d+/i)) {
    return Promise.resolve({ streams: [] });
  }

  return cacheWrapStream(args.id, () => limiter.schedule(() => streamHandler(args)
      .then(records => records
          .sort((a, b) => b.torrent.seeders - a.torrent.seeders || b.torrent.uploadDate - a.torrent.uploadDate)
          .map(record => toStreamInfo(record)))))
      .then(streams => filterByProvider(streams, args.extra.providers || defaultProviders))
      .then(streams => applySorting(streams, args.extra))
      .then(streams => applyMochs(streams, args.extra))
      .then(streams => ({
        streams: streams,
        cacheMaxAge: streams.length ? CACHE_MAX_AGE : CACHE_MAX_AGE_EMPTY,
        staleRevalidate: STALE_REVALIDATE_AGE,
        staleError: STALE_ERROR_AGE
      }))
      .catch(error => {
        console.log(`Failed request ${args.id}: ${error}`);
        throw Promise.reject(error);
      });
});

async function streamHandler(args) {
  if (args.type === Type.MOVIE) {
    return movieRecordsHandler(args);
  } else if (args.type === Type.SERIES) {
    return seriesRecordsHandler(args);
  }
  return Promise.reject('not supported type');
}

async function seriesRecordsHandler(args) {
  if (args.id.match(/tt\d+/)) {
    const parts = args.id.split(':');
    const imdbId = parts[0];
    const season = parts[1] ? parseInt(parts[1], 10) : 1;
    const episode = parts[2] ? parseInt(parts[2], 10) : 1;
    return repository.getImdbIdSeriesEntries(imdbId, season, episode);
  } else if (args.id.match(/kitsu:\d+/i)) {
    const parts = args.id.split(':');
    const kitsuId = parts[1];
    const episode = parts[2] ? parseInt(parts[2], 10) : 1;
    return repository.getKitsuIdSeriesEntries(kitsuId, episode);
  }
  return Promise.reject(`Unsupported id type: ${args.id}`);
}

async function movieRecordsHandler(args) {
  if (args.id.match(/tt\d+/)) {
    const parts = args.id.split(':');
    const imdbId = parts[0];
    return repository.getImdbIdMovieEntries(imdbId);
  } else if (args.id.match(/kitsu:\d+/i)) {
    const parts = args.id.split(':');
    const kitsuId = parts[1];
    return repository.getKitsuIdMovieEntries(kitsuId);
  }
  return Promise.reject(`Unsupported id type: ${args.id}`);
}

function filterByProvider(streams, providers) {
  if (!providers || !providers.length) {
    return streams;
  }
  return streams.filter(stream => {
    const match = stream.title.match(/[🛈⚙].* ([^ \n]+)/);
    const provider = match && match[1].toLowerCase();
    return providers.includes(provider);
  })
}

module.exports = builder.getInterface();
