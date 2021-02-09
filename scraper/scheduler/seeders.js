const Bottleneck = require('bottleneck');
const repository = require('../lib/repository')
const { delay } = require('../lib/promises')
const { updateCurrentSeeders } = require('../lib/torrent')
const { updateTorrentSeeders } = require('../lib/torrentEntries')

const DELAY_MS = 0; // 0 seconds
const updateLimiter = new Bottleneck({ maxConcurrent: 5 });
const statistics = {};

function scheduleUpdateSeeders() {
  console.log('Starting seeders update...')
  return repository.getUpdateSeedersTorrents(100)
      .then(torrents => updateCurrentSeeders(torrents))
      .then(updatedTorrents => Promise.all(
          updatedTorrents.map(updated => updateLimiter.schedule(() => updateTorrentSeeders(updated)))))
      .then(torrents => updateStatistics(torrents))
      .then(() => console.log('Finished seeders update:', statistics))
      .catch(error => console.warn('Failed seeders update:', error))
      .then(() => delay(DELAY_MS))
      .then(() => scheduleUpdateSeeders());
}

function updateStatistics(updatedTorrents) {
  const totalTorrents = updatedTorrents.map(nested => nested.length).reduce((a, b) => a + b, 0);
  const date = new Date().toISOString().replace(/T.*/, '');
  statistics[date] = (statistics[date] || 0) + totalTorrents;
}

module.exports = { scheduleUpdateSeeders }