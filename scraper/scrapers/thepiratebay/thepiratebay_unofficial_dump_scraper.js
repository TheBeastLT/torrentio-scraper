const moment = require('moment');
const Bottleneck = require('bottleneck');
const LineByLineReader = require('line-by-line');
const fs = require('fs');
const decode = require('magnet-uri');
const thepiratebay = require('./thepiratebay_api.js');
const { Type } = require('../../lib/types');
const { createTorrentEntry, createSkipTorrentEntry, getStoredTorrentEntry } = require('../../lib/torrentEntries');

const NAME = 'ThePirateBay';
const CSV_FILE_PATH = '/tmp/tpb.csv';

const limiter = new Bottleneck({ maxConcurrent: 40 });

async function scrape() {
  console.log(`starting to scrape tpb dump...`);
  //const checkPoint = moment('2013-06-16 00:00:00', 'YYYY-MMM-DD HH:mm:ss').toDate();
  const checkPoint = 4115000;

  let entriesProcessed = 0;
  const lr = new LineByLineReader(CSV_FILE_PATH);
  lr.on('line', (line) => {
    if (entriesProcessed % 1000 === 0) {
      console.log(`Processed ${entriesProcessed} entries`);
    }
    if (entriesProcessed <= checkPoint) {
      entriesProcessed++;
      return;
    }

    const row = line.match(/(?<=^|,)(".*"|[^,]*)(?=,|$)/g);
    if (row.length !== 10) {
      console.log(`Invalid row: ${line}`);
      return;
    }
    const torrent = {
      torrentId: row[0],
      title: row[1]
          .replace(/^"|"$/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&\w{2,6};/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      size: parseInt(row[2], 10),
      category: row[4],
      subcategory: row[5],
      infoHash: row[7].toLowerCase() || decode(row[9]).infoHash,
      magnetLink: row[9],
      uploadDate: moment(row[8]).toDate(),
    };

    if (!limiter.empty()) {
      lr.pause()
    }

    limiter.schedule(() => processTorrentRecord(torrent)
        .catch((error) => console.log(`failed ${torrent.title} due: ${error}`)))
        .then(() => limiter.empty())
        .then((empty) => empty && lr.resume())
        .then(() => entriesProcessed++);
  });
  lr.on('error', (err) => {
    console.log(err);
  });
  lr.on('end', () => {
    console.log(`finished to scrape tpb dump!`);
  });
}

const allowedCategories = [
  thepiratebay.Categories.VIDEO.MOVIES,
  thepiratebay.Categories.VIDEO.MOVIES_HD,
  thepiratebay.Categories.VIDEO.MOVIES_DVDR,
  thepiratebay.Categories.VIDEO.MOVIES_3D,
  thepiratebay.Categories.VIDEO.TV_SHOWS,
  thepiratebay.Categories.VIDEO.TV_SHOWS_HD
];
const seriesCategories = [
  thepiratebay.Categories.VIDEO.TV_SHOWS,
  thepiratebay.Categories.VIDEO.TV_SHOWS_HD
];

async function processTorrentRecord(record) {
  if (record.category !== 'Video') {
    return createSkipTorrentEntry(record);
  }
  if (await getStoredTorrentEntry(record)) {
    return;
  }

  const torrentFound = await thepiratebay.torrent(record.torrentId).catch(() => undefined);

  if (!torrentFound || !allowedCategories.includes(torrentFound.subcategory)) {
    return createSkipTorrentEntry(record);
  }

  const torrent = {
    infoHash: record.infoHash,
    provider: NAME,
    torrentId: record.torrentId,
    title: torrentFound.name,
    size: torrentFound.size,
    type: seriesCategories.includes(torrentFound.subcategory) ? Type.SERIES : Type.MOVIE,
    imdbId: torrentFound.imdbId,
    uploadDate: torrentFound.uploadDate,
    seeders: torrentFound.seeders,
  };

  return createTorrentEntry(torrent);
}

module.exports = { scrape, NAME };