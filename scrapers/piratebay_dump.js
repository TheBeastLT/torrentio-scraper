const moment = require('moment');
const needle = require('needle');
const Bottleneck = require('bottleneck');
const { ungzip } = require('node-gzip');
const LineByLineReader = require('line-by-line');
const fs = require('fs');
const { parse } = require('parse-torrent-title');
const pirata = require('./api/thepiratebay');
const bing = require('nodejs-bing');
const { Type } = require('../lib/types');
const repository = require('../lib/repository');
const { getImdbId, escapeTitle } = require('../lib/metadata');
const { parseTorrentFiles } = require('../lib/torrentFiles');

const NAME = 'ThePirateBay';
const CSV_FILE_PATH = '/tmp/tpb_dump.csv';

const limiter = new Bottleneck({maxConcurrent: 40});

async function scrape() {
  const lastScraped = await repository.getProvider({ name: NAME });
  const lastDump = { updatedAt: 2147000000 };
  const checkPoint = moment('2019-03-30 00:00:00', 'YYYY-MMM-DD HH:mm:ss').toDate();
  //const lastDump = await pirata.dumps().then((dumps) => dumps.sort((a, b) => b.updatedAt - a.updatedAt)[0]);

  if (!lastScraped.lastScraped || lastScraped.lastScraped < lastDump.updatedAt) {
    console.log(`starting to scrape tpb dump: ${JSON.stringify(lastDump)}`);
    //await downloadDump(lastDump);

    let entriesProcessed = 0;
    const lr = new LineByLineReader(CSV_FILE_PATH);
    lr.on('line', (line) => {
      if (line.includes("#ADDED")) {
        return;
      }
      if (entriesProcessed % 1000 === 0) {
        console.log(`Processed ${entriesProcessed} entries`);
      }
      const row = line.match(/(?<=^|;)(".*"|[^;]+)(?=;|$)/g);
      if (row.length !== 4) {
        console.log(`Invalid row: ${line}`);
        return;
      }
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

      if (torrent.uploadDate > checkPoint) {
        entriesProcessed++;
        return;
      }

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
          .then((empty) => empty && lr.resume())
          .then(() => entriesProcessed++);
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
  const alreadyExists = await repository.getSkipTorrent(record)
      .catch(() => repository.getTorrent(record))
      .catch(() => undefined);
  if (alreadyExists) {
     return;
  }

  const torrentFound = await findTorrent(record);

  if (!torrentFound) {
    //console.log(`not found: ${JSON.stringify(record)}`);
    repository.createSkipTorrent(record);
    return;
  }
  if (!allowedCategories.includes(torrentFound.subcategory)) {
    //console.log(`wrong category: ${torrentFound.name}`);
    repository.createSkipTorrent(record);
    return;
  }

  const type = seriesCategories.includes(torrentFound.subcategory) ? Type.SERIES : Type.MOVIE;
  const titleInfo = parse(torrentFound.name);
  const imdbId = await getImdbId({
    name: escapeTitle(titleInfo.title).toLowerCase(),
    year: titleInfo.year,
    type: type
  }).catch((error) => undefined);
  const torrent = {
    infoHash: record.infoHash,
    provider: NAME,
    title: torrentFound.name,
    size: record.size,
    type: type,
    uploadDate: record.uploadDate,
    seeders: torrentFound.seeders,
  };

  if (!imdbId) {
    console.log(`imdbId not found: ${torrentFound.name}`);
    repository.createFailedImdbTorrent(torrent);
    return;
  }

  const files = await parseTorrentFiles(torrent, imdbId);
  if (!files || !files.length) {
    console.log(`no video files found: ${torrentFound.name}`);
    return;
  }

  repository.createTorrent(torrent)
      .then(() => files.forEach(file => repository.createFile(file)));
  console.log(`Created entry for ${torrentFound.name}`);
}

async function findTorrent(record) {
  return findTorrentInSource(record)
      .catch((error) => findTorrentViaBing(record));
}

async function findTorrentInSource(record) {
  let page = 0;
  let torrentFound;
  while (!torrentFound && page < 5) {
    const torrents = await pirata.search(record.title.replace(/[\W\s]+/, ' '), { page: page });
    torrentFound = torrents.filter(torrent => torrent.magnetLink.toLowerCase().includes(record.infoHash))[0];
    page = torrents.length === 0 ? 1000 : page + 1;
  }
  if (!torrentFound) {
    return Promise.reject(new Error(`Failed to find torrent ${record.title}`));
  }
  return Promise.resolve(torrentFound);
}

async function findTorrentViaBing(record) {
  return bing.web(`${record.infoHash}`)
      .then((results) => results
          .find(result => result.description.includes('Direct download via magnet link') || result.description.includes('Get this torrent')))
      .then((result) => {
        if (!result) {
          throw new Error(`Failed to find torrent ${record.title}`);
        }
        return result.link.match(/torrent\/(\w+)\//)[1];
      })
      .then((torrentId) => pirata.torrent(torrentId))
}

function downloadDump(dump) {
  console.log('downloading dump file...');
  return needle('get', dump.url, { open_timeout: 2000, output: '/tmp/tpb_dump.gz' })
      .then((response) => response.body)
      .then((body) => { console.log('unzipping dump file...'); return ungzip(body); })
      .then((unzipped) => { console.log('writing dump file...'); return fs.promises.writeFile(CSV_FILE_PATH, unzipped); })
}

module.exports = { scrape };