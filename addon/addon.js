const { addonBuilder } = require('stremio-addon-sdk');
const { manifest } = require('./lib/manifest');
const { cacheWrapStream } = require('./lib/cache');
const { toStreamInfo, sanitizeStreamInfo } = require('./lib/streamInfo');
const repository = require('./lib/repository');
const applyStreamSorting = require('./lib/sort');
const applyMochs = require('./moch/moch');

const CACHE_MAX_AGE = process.env.CACHE_MAX_AGE || 4 * 60 * 60; // 4 hours in seconds
const CACHE_MAX_AGE_EMPTY = 30 * 60; // 30 minutes
const STALE_REVALIDATE_AGE = 4 * 60 * 60; // 4 hours
const STALE_ERROR_AGE = 7 * 24 * 60 * 60; // 7 days

const builder = new addonBuilder(manifest());

builder.defineStreamHandler((args) => {
  if (!args.id.match(/tt\d+/i) && !args.id.match(/kitsu:\d+/i)) {
    return Promise.resolve({ streams: [] });
  }

  const handlers = {
    series: () => seriesRecordsHandler(args).then(records => records.map(record => toStreamInfo(record))),
    movie: () => movieRecordsHandler(args).then(records => records.map(record => toStreamInfo(record))),
    fallback: () => Promise.reject('not supported type')
  };

  return cacheWrapStream(args.id, (handlers[args.type] || handlers.fallback))
      .then(streams => filterStreamByProvider(streams, args.extra.providers))
      .then(streams => applyStreamSorting(streams, args.extra))
      .then(streams => applyMochs(streams, args.extra))
      .then(streams => streams.map(stream => sanitizeStreamInfo(stream)))
      .then(streams => ({
        streams: streams,
        cacheMaxAge: streams.length ? CACHE_MAX_AGE : CACHE_MAX_AGE_EMPTY,
        staleRevalidate: STALE_REVALIDATE_AGE,
        staleError: STALE_ERROR_AGE
      }))
      .catch(error => {
        console.log(`Failed request ${args.id}: ${error}`);
        throw error;
      });
});

async function seriesRecordsHandler(args) {
  if (args.id.match(/tt\d+/)) {
    const parts = args.id.split(':');
    const imdbId = parts[0];
    const season = parseInt(parts[1], 10);
    const episode = parseInt(parts[2], 10);
    return repository.getImdbIdSeriesEntries(imdbId, season, episode);
  } else if (args.id.match(/kitsu:\d+/i)) {
    const parts = args.id.split(':');
    const kitsuId = parts[1];
    const episode = parseInt(parts[2], 10);
    return repository.getKitsuIdSeriesEntries(kitsuId, episode);
  }
  return Promise.reject(`Unsupported id type: ${args.id}`);
}

async function movieRecordsHandler(args) {
  if (args.id.match(/tt\d+/)) {
    return repository.getImdbIdMovieEntries(args.id);
  } else if (args.id.match(/kitsu:\d+/i)) {
    return repository.getKitsuIdMovieEntries(args.id.replace('kitsu:', ''));
  }
  return Promise.reject(`Unsupported id type: ${args.id}`);
}

function filterStreamByProvider(streams, providers) {
  if (!providers || !providers.length) {
    return streams;
  }
  return streams.filter(stream => providers.includes(stream.name.split('\n')[1].toLowerCase()))
}

module.exports = builder.getInterface();
