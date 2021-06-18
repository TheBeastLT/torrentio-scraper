const moment = require('moment');
const { Sequelize } = require('sequelize');
const thepiratebay = require('./thepiratebay_api.js');
const { Type } = require('../../lib/types');
const repository = require('../../lib/repository');
const Promises = require('../../lib/promises');

const NAME = 'ThePirateBay';
const EMPTY_HASH = '0000000000000000000000000000000000000000';

const Op = Sequelize.Op;

async function scrape() {
  console.log(`Starting ${NAME} fake removal...`);
  const startCreatedAt = moment().subtract(14, 'day');
  const endCreatedAt = moment().subtract(1, 'day');
  const whereQuery = {
    provider: NAME,
    type: Type.MOVIE,
    createdAt: { [Op.between]: [startCreatedAt, endCreatedAt] }
  };
  return repository.getTorrentsBasedOnQuery(whereQuery)
      .then(torrents => {
        console.log(`Checking for ${NAME} fake entries in ${torrents.length} torrents`);
        return Promises.sequence(torrents.map(torrent => () => removeIfFake(torrent)))
      })
      .then(results => {
        const removed = results.filter(result => result);
        console.log(`Finished ${NAME} fake removal with ${removed.length} removals in ${results.length} torrents`);
      });
}

async function removeIfFake(torrent) {
  const tpbTorrentInfo = await thepiratebay.torrent(torrent.torrentId).catch(() => null);
  if (tpbTorrentInfo && tpbTorrentInfo.infoHash === EMPTY_HASH) {
    console.log(`Removing ${NAME} fake torrent [${torrent.torrentId}][${torrent.infoHash}] ${torrent.title}`);
    return repository.deleteTorrent(torrent).catch(() => null);
  }
  return Promise.resolve(null);
}

module.exports = { scrape, NAME };
