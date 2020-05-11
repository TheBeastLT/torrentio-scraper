const moment = require('moment');
const Bottleneck = require('bottleneck');
const rarbg = require('rarbg-api');
const decode = require('magnet-uri');
const { Type } = require('../../lib/types');
const { createTorrentEntry, checkAndUpdateTorrent } = require('../../lib/torrentEntries');

const NAME = 'RARBG';

const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 2500 });
const entryLimiter = new Bottleneck({ maxConcurrent: 40 });
const allowedCategories = [
  rarbg.CATEGORY.MOVIES_XVID,
  rarbg.CATEGORY.MOVIES_XVID_720P,
  rarbg.CATEGORY.MOVIES_X265_1080P,
  rarbg.CATEGORY.MOVIES_X265_4K,
  rarbg.CATEGORY.MOVIES_X265_4K_HDR,
  rarbg.CATEGORY.MOVIES_X264,
  rarbg.CATEGORY.MOVIES_X264_720P,
  rarbg.CATEGORY.MOVIES_X264_1080P,
  rarbg.CATEGORY.MOVIES_X264_3D,
  rarbg.CATEGORY.MOVIES_X264_4K,
  rarbg.CATEGORY.MOVIES_BD_REMUX,
  rarbg.CATEGORY.TV_EPISODES,
  rarbg.CATEGORY.TV_UHD_EPISODES,
  rarbg.CATEGORY.TV_HD_EPISODES
].reduce((a, b) => a.concat(b), [])
const searchOptions = { limit: 100, category: allowedCategories, sort: 'seeders', format: 'json_extended', ranked: 0 }

async function scrape() {
  console.log(`[${moment()}] starting ${NAME} dump scrape...`);
  // const movieImdbIds = require('./rargb_movie_imdb_ids_2020-04-22.json');
  const seriesImdbIds = require('./rargb_series_imdb_ids_2020-04-22.json');
  //const allImdbIds = [].concat(movieImdbIds).concat(seriesImdbIds);

  return Promise.all(
      seriesImdbIds.map(imdbId => limiter.schedule(() => getTorrentsForImdbId(imdbId))
          .then(torrents => Promise.all(torrents.map(t => entryLimiter.schedule(() => processTorrentRecord(t)))))))
      .then(() => console.log(`[${moment()}] finished ${NAME} dump scrape`));
}

async function getTorrentsForImdbId(imdbId, retries = 5) {
  return rarbg.search(imdbId, searchOptions, 'imdb')
      .then(torrents => torrents.map(torrent => ({
        name: torrent.title,
        infoHash: decode(torrent.download).infoHash,
        magnetLink: torrent.download,
        seeders: torrent.seeders,
        leechers: torrent.leechers,
        category: torrent.category,
        size: torrent.size,
        uploadDate: new Date(torrent.pubdate),
        imdbId: torrent.episode_info && torrent.episode_info.imdb
      })))
      .then(torrents => {
        console.log(`Completed ${imdbId} request`);
        return torrents;
      })
      .catch(error => {
        if (retries > 0) {
          console.log(`Retrying ${NAME} request for ${imdbId}...`);
          return getTorrentsForImdbId(imdbId, retries - 1);
        }
        console.warn(`Failed ${NAME} request for ${imdbId}: `, error);
        return [];
      });
}

async function processTorrentRecord(record) {
  if (await checkAndUpdateTorrent(record)) {
    return record;
  }

  const torrent = {
    provider: NAME,
    infoHash: record.infoHash,
    title: record.name,
    type: getType(record.category),
    seeders: record.seeders,
    size: record.size,
    uploadDate: record.uploadDate,
    imdbId: record.imdbId
  };

  return createTorrentEntry(torrent);
}

const seriesCategories = [
  'TV Episodes',
  'Movies/TV-UHD-episodes',
  'TV HD Episodes',
];

function getType(category) {
  if (seriesCategories.includes(category)) {
    return Type.SERIES;
  }
  return Type.MOVIE;
}

module.exports = { scrape, NAME };