const moment = require('moment');
const Bottleneck = require('bottleneck');
const rarbg = require('./rarbg_api');
const { Type } = require('../../lib/types');
const { createTorrentEntry, checkAndUpdateTorrent } = require('../../lib/torrentEntries');

const NAME = 'RARBG';

const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 3000 });
const entryLimiter = new Bottleneck({ maxConcurrent: 20 });
const allowedCategories = [
  rarbg.Options.category.MOVIES_XVID,
  rarbg.Options.category.MOVIES_XVID_720P,
  rarbg.Options.category.MOVIES_X265_1080P,
  rarbg.Options.category.MOVIES_X264,
  rarbg.Options.category.MOVIES_X264_720P,
  rarbg.Options.category.MOVIES_X264_1080P,
  rarbg.Options.category.MOVIES_HIGH_RES,
  rarbg.Options.category.TV_EPISODES,
  rarbg.Options.category.TV_UHD_EPISODES,
  rarbg.Options.category.TV_HD_EPISODES
].reduce((a, b) => a.concat(b), [])

async function scrape() {
  console.log(`[${moment()}] starting ${NAME} dump scrape...`);
  // const movieImdbIds = require('./rargb_movie_imdb_ids_2021-02-27.json');
  const seriesImdbIds = require('./rargb_series_imdb_ids_2021-02-27.json');
  //const allImdbIds = [].concat(movieImdbIds).concat(seriesImdbIds);

  return Promise.all(
          seriesImdbIds.map(imdbId => limiter.schedule(() => getTorrentsForImdbId(imdbId))
              .then(torrents => Promise.all(torrents.map(t => entryLimiter.schedule(() => processTorrentRecord(t)))))))
      .then(() => console.log(`[${moment()}] finished ${NAME} dump scrape`));
}

async function getTorrentsForImdbId(imdbId) {
  return rarbg.search(imdbId, { category: allowedCategories })
      .then(torrents => {
        console.log(`Completed ${imdbId} request`);
        return torrents;
      })
      .catch(error => {
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
    title: record.title,
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