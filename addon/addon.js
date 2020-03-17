const { addonBuilder } = require('stremio-addon-sdk');
const { manifest } = require('./lib/manifest');
const { cacheWrapStream } = require('./lib/cache');
const { toStreamInfo, sanitizeStreamInfo } = require('./lib/streamInfo');
const repository = require('./lib/repository');
const realdebrid = require('./moch/realdebrid');

const CACHE_MAX_AGE = process.env.CACHE_MAX_AGE || 4 * 60 * 60; // 4 hours in seconds
const CACHE_MAX_AGE_EMPTY = 30 * 60; // 30 minutes
const STALE_REVALIDATE_AGE = 4 * 60 * 60; // 4 hours
const STALE_ERROR_AGE = 7 * 24 * 60 * 60; // 7 days

const MOCHS = {
  'realdebrid': realdebrid
};

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
      .then(streams => filterStreamsBySeeders(streams))
      .then(streams => sortStreamsByVideoQuality(streams))
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

const HEALTHY_SEEDERS = 5;
const SEEDED_SEEDERS = 1;
const MIN_HEALTHY_COUNT = 10;
const MAX_UNHEALTHY_COUNT = 5;

function filterStreamsBySeeders(streams) {
  const sortedStreams = streams
      .sort((a, b) => b.filters.seeders - a.filters.seeders || b.filters.uploadDate - a.filters.uploadDate);
  const healthy = sortedStreams.filter(stream => stream.filters.seeders >= HEALTHY_SEEDERS);
  const seeded = sortedStreams.filter(stream => stream.filters.seeders >= SEEDED_SEEDERS);

  if (healthy.length >= MIN_HEALTHY_COUNT) {
    return healthy;
  } else if (seeded.length >= MAX_UNHEALTHY_COUNT) {
    return seeded.slice(0, MIN_HEALTHY_COUNT);
  }
  return sortedStreams.slice(0, MAX_UNHEALTHY_COUNT);
}

function sortStreamsByVideoQuality(streams) {
  const qualityMap = streams
      .reduce((map, stream) => {
        const quality = stream.filters.quality;
        map[quality] = (map[quality] || []).concat(stream);
        return map;
      }, {});
  const sortedQualities = Object.keys(qualityMap)
      .sort((a, b) => {
        const aQuality = a === '4k' ? '2160p' : a;
        const bQuality = b === '4k' ? '2160p' : b;
        const aResolution = aQuality && aQuality.match(/\d+p/) && parseInt(aQuality, 10);
        const bResolution = bQuality && bQuality.match(/\d+p/) && parseInt(bQuality, 10);
        if (aResolution && bResolution) {
          return bResolution - aResolution; // higher resolution first;
        } else if (aResolution) {
          return -1;
        } else if (bResolution) {
          return 1;
        }
        return a < b ? -1 : b < a ? 1 : 0;
      });
  return sortedQualities
      .map(quality => qualityMap[quality])
      .reduce((a, b) => a.concat(b), []);
}

function applyMochs(streams, config) {
  if (!streams || !streams.length) {
    return streams;
  }

  return Object.keys(config)
      .filter(configKey => MOCHS[configKey])
      .reduce(async (streams, moch) => {
        return await MOCHS[moch].applyMoch(streams, config[moch])
            .catch(error => {
              console.warn(error);
              return streams;
            });
      }, streams);
}

module.exports = builder.getInterface();
