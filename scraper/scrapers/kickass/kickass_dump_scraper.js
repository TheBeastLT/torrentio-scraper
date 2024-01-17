const moment = require('moment');
const Bottleneck = require('bottleneck');
const LineByLineReader = require('line-by-line');
const fs = require('fs');
const { Type } = require('../../lib/types');
const { createTorrentEntry, createSkipTorrentEntry, getStoredTorrentEntry } = require('../../lib/torrentEntries');

const NAME = 'KickassTorrents';
const CSV_FILE_PATH = '/tmp/kickass.csv';

const limiter = new Bottleneck({ maxConcurrent: 40 });

async function scrape() {
  console.log(`starting to scrape KAT dump: ${JSON.stringify(lastDump)}`);

  let entriesProcessed = 0;
  const lr = new LineByLineReader(CSV_FILE_PATH);
  lr.on('line', (line) => {
    if (entriesProcessed % 1000 === 0) {
      console.log(`Processed ${entriesProcessed} entries`);
    }
    const row = line.match(/(?<=^|\|)(".*"|[^|]+)(?=\||$)/g);
    if (row.length !== 11) {
      console.log(`Invalid row: ${line}`);
      return;
    }
    const torrent = {
      infoHash: row[0].toLowerCase(),
      title: row[1]
          .replace(/^"|"$/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&\w{2,6};/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      category: row[2],
      size: parseInt(row[5], 10),
      seeders: parseInt(row[8], 10),
      uploadDate: moment.unix(parseInt(row[10], 10)).toDate(),
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
    fs.unlink(CSV_FILE_PATH);
    console.log(`finished to scrape KAT dump: ${JSON.stringify(lastDump)}!`);
  });
}

const categoryMapping = {
  "Movies": Type.MOVIE,
  "TV": Type.SERIES,
  "Anime": Type.ANIME
};

async function processTorrentRecord(record) {
  if (!categoryMapping[record.category] || record.seeders === 0) {
    return createSkipTorrentEntry(record);
  }
  if (await getStoredTorrentEntry(record)) {
    return;
  }

  const torrentFound = await findTorrent(record).catch(() => undefined);

  if (!torrentFound) {
    return createSkipTorrentEntry(record);
  }

  const torrent = {
    infoHash: record.infoHash,
    provider: NAME,
    title: torrentFound.name,
    size: record.size,
    type: categoryMapping[record.category],
    imdbId: torrentFound.imdbId,
    uploadDate: record.uploadDate,
    seeders: torrentFound.seeders,
  };

  return createTorrentEntry(torrent);
}

async function findTorrent(record) {
  return Promise.reject("not found");
}

module.exports = { scrape, NAME };