const moment = require('moment');
const needle = require('needle');
const Bottleneck = require('bottleneck');
const { ungzip } = require('node-gzip');
const LineByLineReader = require('line-by-line');
const fs = require('fs');
const { parse } = require('parse-torrent-title');
const pirata = require('./api/thepiratebay');
const { torrentFiles } = require('../lib/torrent');
const repository = require('../lib/repository');
const { getImdbId, escapeTitle } = require('../lib/metadata');

const NAME = 'ThePirateBay';
const CSV_FILE_PATH = '/tmp/tpb_dump.csv';

const limiter = new Bottleneck({maxConcurrent: 40});

async function scrape() {
  const lastScraped = await repository.getProvider({ name: NAME });
  const lastDump = await pirata.dumps().then((dumps) => dumps.sort((a, b) => b.updatedAt - a.updatedAt)[0]);

  if (!lastScraped.lastScraped || lastScraped.lastScraped < lastDump.updatedAt) {
    console.log(`starting to scrape tpb dump: ${JSON.stringify(lastDump)}`);
    //await downloadDump(lastDump);

    const lr = new LineByLineReader(CSV_FILE_PATH);
    lr.on('line', (line) => {
      if (line.includes("#ADDED")) {
        return;
      }
      const row = line.match(/(?<=^|;)(".*"|[^;]+)(?=;|$)/g);
      const torrent = {
        uploadDate: moment(row[0], 'YYYY-MMM-DD HH:mm:ss').toDate(),
        infoHash: Buffer.from(row[1], 'base64').toString('hex'),
        title: row[2]
            .replace(/^"|"$/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&\w{2,6};/g, ' ')
            .replace(/\s+/g, ' '),
        size: parseInt(row[3], 10)
      };

      if (lastScraped.lastScraped && lastScraped.lastScraped > torrent.uploadDate) {
        // torrent was already scraped previously, skipping
        return;
      }

      if (!limiter.empty()) {
        lr.pause()
      }

      limiter.schedule(() => processTorrentRecord(torrent)
            .catch((error) => console.log(`failed ${torrent.title} due: ${error}`)))
            .then(() => limiter.empty())
            .then((empty) => empty && lr.resume());
    });
    lr.on('error', (err) => {
        console.log(err);
    });
    lr.on('end', () => {
        fs.unlink(CSV_FILE_PATH);
        updateProvider({ name: NAME, lastScraped: lastDump.updatedAt });
        console.log(`finished to scrape tpb dump: ${JSON.stringify(lastDump)}!`);
    });
  }
}
const allowedCategories = [
  pirata.Categories.VIDEO.MOVIES,
  pirata.Categories.VIDEO.MOVIES_HD,
  pirata.Categories.VIDEO.MOVIES_DVDR,
  pirata.Categories.VIDEO.MOVIES_3D,
  pirata.Categories.VIDEO.TV_SHOWS,
  pirata.Categories.VIDEO.TV_SHOWS_HD
];
const seriesCategories = [
  pirata.Categories.VIDEO.TV_SHOWS,
  pirata.Categories.VIDEO.TV_SHOWS_HD
];
async function processTorrentRecord(record) {
  const persisted = await repository.getSkipTorrent(record)
      .catch(() => repository.getTorrent(record)).catch(() => undefined);
  if (persisted) {
     return;
  }

  let page = 0;
  let torrentFound;
  while (!torrentFound && page < 5) {
    const torrents = await pirata.search(record.title.replace(/[\W\s]+/, ' '), { page: page });
    torrentFound = torrents.
    filter(torrent => torrent.magnetLink.toLowerCase().includes(record.infoHash))[0];
    page = torrents.length === 0 ? 1000 : page + 1;
  }

  if (!torrentFound) {
    console.log(`not found: ${JSON.stringify(record)}`);
    repository.createSkipTorrent(record);
    return;
  }
  if (!allowedCategories.includes(torrentFound.subcategory)) {
    console.log(`wrong category: ${torrentFound.name}`);
    repository.createSkipTorrent(record);
    return;
  }

  const type = seriesCategories.includes(torrentFound.subcategory) ? 'series' : 'movie';
  console.log(`imdbId search: ${torrentFound.name}`);
  const titleInfo = parse(torrentFound.name);
  const imdbId = await getImdbId({
    name: escapeTitle(titleInfo.title).toLowerCase(),
    year: titleInfo.year,
    type: type
  }).catch(() => undefined);

  if (!imdbId) {
    console.log(`imdbId not found: ${torrentFound.name}`);
    repository.updateTorrent({
      infoHash: record.infoHash,
      provider: NAME,
      title: torrentFound.name,
      uploadDate: record.uploadDate,
      seeders: torrentFound.seeders,
    });
    return;
  }

  if (type === 'movie' || titleInfo.episode) {
    repository.updateTorrent({
      infoHash: record.infoHash,
      provider: NAME,
      title: torrentFound.name,
      imdbId: imdbId,
      uploadDate: record.uploadDate,
      seeders: torrentFound.seeders,
    });
    return;
  }

  const files = await torrentFiles(record).catch(() => []);
  if (!files || !files.length) {
    console.log(`no video files found: ${torrentFound.name}`);
    return;
  }

  repository.updateTorrent({
    infoHash: record.infoHash,
    provider: NAME,
    title: torrentFound.name,
    imdbId: imdbId,
    uploadDate: record.uploadDate,
    seeders: torrentFound.seeders,
    files: files
  })
}

function downloadDump(dump) {
  console.log('downloading dump file...');
  return needle('get', dump.url, { open_timeout: 2000, output: '/home/paulius/Downloads/tpb_dump.gz' })
      .then((response) => response.body)
      .then((body) => { console.log('unzipping dump file...'); return ungzip(body); })
      .then((unzipped) => { console.log('writing dump file...'); return fs.promises.writeFile(CSV_FILE_PATH, unzipped); })
}

module.exports = { scrape };