const { addonBuilder } = require('stremio-addon-sdk');
const { cacheWrapStream } = require('./lib/cache');

const CACHE_MAX_AGE = process.env.CACHE_MAX_AGE || 24 * 60; // 24 hours in seconds
const CACHE_MAX_AGE_EMPTY = 4 * 60; // 4 hours in seconds
const STALE_REVALIDATE_AGE = 4 * 60; // 4 hours
const STALE_ERROR_AGE = 7 * 24 * 60; // 7 days
const EMPTY_OBJECT = {};

const builder = new addonBuilder({
  id: 'com.stremio.torrentio.addon',
  version: '1.0.0',
  name: 'Torrentio',
  description: 'Provides torrent stream from scraped torrent providers. Currently support ThePirateBay, 1337x, RARBG, KickassTorrents, HorribleSubs.',
  catalogs: [],
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  background: `https://i.imgur.com/t8wVwcg.jpg`,
  logo: `https://i.imgur.com/dPa2clS.png`,
});

builder.defineStreamHandler((args) => {
  if (!args.id.match(/tt\d+/i)) {
    return Promise.resolve({ streams: [] });
  }

  const handlers = {
    series: () => seriesStreamHandler(args),
    movie: () => movieStreamHandler(args),
    fallback: () => Promise.reject('not supported type')
  };

  return cacheWrapStream(args.id, handlers[args.type] || handlers.fallback)
      .then((streams) => ({
        streams: streams,
        cacheMaxAge: streams.length ? CACHE_MAX_AGE : CACHE_MAX_AGE_EMPTY,
        staleRevalidate: STALE_REVALIDATE_AGE,
        staleError: STALE_ERROR_AGE
      }))
      .catch((error) => {
        console.log(`Failed request ${args.id}: ${error}`);
        throw error;
      });
});

async function seriesStreamHandler(args) {

}

async function movieStreamHandler(args) {

}

module.exports = builder.getInterface();
