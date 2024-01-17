const Bottleneck = require('bottleneck');
const repository = require('../lib/repository')
const { delay } = require('../lib/promises')
const { updateCurrentSeeders } = require('../lib/torrent')
const { updateTorrentSeeders } = require('../lib/torrentEntries')

const DELAY_MS = 0; // 0 seconds
const updateLimiter = new Bottleneck({ maxConcurrent: 5 });
const statistics = {};
const statisticsNew = {};

function scheduleUpdateSeeders() {
  console.log('Starting seeders update...')
  getTorrents()
      .then(torrents => updateCurrentSeeders(torrents))
      .then(updatedTorrents => Promise.all(
          updatedTorrents.map(updated => updateLimiter.schedule(() => updateTorrentSeeders(updated)))))
      .then(torrents => updateStatistics(torrents, statistics))
      .then(() => console.log('Finished seeders update:', statistics))
      .catch(error => console.warn('Failed seeders update:', error))
      .then(() => delay(DELAY_MS))
      .then(() => scheduleUpdateSeeders());
}

function scheduleUpdateSeedersForNewTorrents() {
  console.log('Starting seeders update for new torrents...')
  getNewTorrents()
      .then(torrents => updateCurrentSeeders(torrents))
      .then(updatedTorrents => Promise.all(
          updatedTorrents.map(updated => updateLimiter.schedule(() => updateTorrentSeeders(updated)))))
      .then(torrents => updateStatistics(torrents, statisticsNew))
      .then(() => console.log('Finished seeders update for new torrents:', statisticsNew))
      .catch(error => console.warn('Failed seeders update for new torrents:', error))
      .then(() => delay(30_000))
      .then(() => scheduleUpdateSeedersForNewTorrents());
}

async function getTorrents() {
  return repository.getUpdateSeedersTorrents()
      .catch(() => delay(5000).then(() => getTorrents()))
}

async function getNewTorrents() {
  return repository.getUpdateSeedersNewTorrents()
      .catch(() => delay(5000).then(() => getNewTorrents()))
}

function updateStatistics(updatedTorrents, statisticsObject) {
  const totalTorrents = updatedTorrents.map(nested => nested.length).reduce((a, b) => a + b, 0);
  const date = new Date().toISOString().replace(/T.*/, '');
  statisticsObject[date] = (statisticsObject[date] || 0) + totalTorrents;
}

module.exports = { scheduleUpdateSeeders, scheduleUpdateSeedersForNewTorrents }