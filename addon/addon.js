const { addonBuilder } = require('stremio-addon-sdk');
const titleParser = require('parse-torrent-title');
const { toStreamInfo } = require('./lib/streamInfo');
const { cacheWrapStream } = require('./lib/cache');
const repository = require('./lib/repository');

const CACHE_MAX_AGE = process.env.CACHE_MAX_AGE || 24 * 60; // 24 hours in seconds
const CACHE_MAX_AGE_EMPTY = 4 * 60; // 4 hours in seconds
const STALE_REVALIDATE_AGE = 4 * 60; // 4 hours
const STALE_ERROR_AGE = 7 * 24 * 60; // 7 days

const builder = new addonBuilder({
  id: 'com.stremio.torrentio.addon',
  version: '1.0.0',
  name: 'Torrentio',
  description: 'Provides torrent stream from scraped torrent providers. '
      + 'Currently supports ThePirateBay, 1337x, RARBG, KickassTorrents, HorribleSubs.',
  catalogs: [],
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'kitsu'],
  background: `https://i.imgur.com/t8wVwcg.jpg`,
  logo: `https://i.imgur.com/GwxAcDV.png`,
});

builder.defineStreamHandler((args) => {
  if (!args.id.match(/tt\d+/i) && args.id.match(/kitsu:\d+/i)) {
    return Promise.resolve({ streams: [] });
  }

  const handlers = {
    series: () => seriesRecordsHandler(args),
    movie: () => movieRecordsHandler(args),
    fallback: () => Promise.reject('not supported type')
  };

  return cacheWrapStream(args.id, handlers[args.type] || handlers.fallback)
      .then(records => filterRecordsBySeeders(records))
      .then(records => sortRecordsByVideoQuality(records))
      .then(records => records.map(record => toStreamInfo(record)))
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
    return repository.getKitsuIdMovieEntries(args.id.replace('kitsu:', ''), episode);
  }
  return Promise.reject(`Unsupported id type: ${args.id}`);
}

const HEALTHY_SEEDERS = 5;
const SEEDED_SEEDERS = 1;
const MIN_HEALTHY_COUNT = 10;
const MAX_UNHEALTHY_COUNT = 5;

function filterRecordsBySeeders(records) {
  const sortedRecords = records
      .sort((a, b) => b.torrent.seeders - a.torrent.seeders || b.torrent.uploadDate - a.torrent.uploadDate);
  const healthy = sortedRecords.filter(record => record.torrent.seeders >= HEALTHY_SEEDERS);
  const seeded = sortedRecords.filter(record => record.torrent.seeders >= SEEDED_SEEDERS);

  if (healthy.length >= MIN_HEALTHY_COUNT) {
    return healthy;
  } else if (seeded.length >= MAX_UNHEALTHY_COUNT) {
    return seeded.slice(0, MIN_HEALTHY_COUNT);
  }
  return sortedRecords.slice(0, MAX_UNHEALTHY_COUNT);
}

function sortRecordsByVideoQuality(records) {
  const qualityMap = records
      .reduce((map, record) => {
        const parsedFile = titleParser.parse(record.title);
        const parsedTorrent = titleParser.parse(record.torrent.title);
        const quality = parsedFile.resolution || parsedTorrent.resolution || parsedFile.source || parsedTorrent.source;
        map[quality] = (map[quality] || []).concat(record);
        return map;
      }, {});
  const sortedQualities = Object.keys(qualityMap)
      .sort((a, b) => {
        const aQuality = a === '4k' ? '2160p' : a === 'undefined' ? undefined : a;
        const bQuality = b === '4k' ? '2160p' : b === 'undefined' ? undefined : b;
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

module.exports = builder.getInterface();
