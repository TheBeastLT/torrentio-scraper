const Bottleneck = require('bottleneck');
const scrapers = require('./scrapers');
const repository = require('../lib/repository')
const { delay, timeout } = require('../lib/promises')
const { updateCurrentSeeders } = require('../lib/torrent')
const { updateTorrentSeeders } = require('../lib/torrentEntries')

const DELAY_MS = 15 * 1000; // 15 seconds
const TIMEOUT_MS = 30 * 1000 // 30 seconds
const limiter = new Bottleneck({ maxConcurrent: 20, minTime: 250 });
const updateLimiter = new Bottleneck({ maxConcurrent: 5 });
const forceSeedersLimiter = new Bottleneck({ maxConcurrent: 5 });
const statistics = {};

function scheduleUpdateSeeders() {
  console.log('Starting seeders update...')
  return repository.getUpdateSeedersTorrents()
      .then(torrents => Promise.all(torrents.map(torrent => limiter
          .schedule(() => timeout(TIMEOUT_MS, _updateSeeders(torrent)))
          .catch(error => {
            console.log(`Failed [${torrent.infoHash}] ${torrent.title} seeders update: `, error);
            return []
          }))))
      .then(torrents => updateStatistics(torrents))
      .then(() => console.log('Finished seeders update:', statistics))
      .catch(error => console.warn('Failed seeders update:', error))
      .then(() => delay(DELAY_MS))
      .then(() => scheduleUpdateSeeders());
}

async function _updateSeeders(torrent) {
  const provider = await scrapers.find(provider => provider.name === torrent.provider);
  if (!provider) {
    console.log(`No provider found for ${torrent.provider} [${torrent.infoHash}]`)
    return Promise.resolve([]);
  }
  const updatedTorrents = await provider.scraper.updateSeeders(torrent, getImdbIdsMethod(torrent))
      .then(updated => Array.isArray(updated) ? updated : [updated])
      .catch(error => {
        console.warn(`Failed seeders update ${torrent.provider} [${torrent.infoHash}]: `, error)
        return []
      });

  if (!updatedTorrents.find(updated => updated.infoHash === torrent.infoHash)) {
    await forceSeedersLimiter.schedule(() => updateCurrentSeeders(torrent))
        .then(updated => updatedTorrents.push(updated));
  }

  return Promise.all(updatedTorrents.map(updated => updateLimiter.schedule(() => updateTorrentSeeders(updated))));
}

function getImdbIdsMethod(torrent) {
  return () => repository.getFiles(torrent)
      .then(files => files.map(file => file.imdbId).filter(id => id))
      .then(ids => Array.from(new Set(ids)));
}

function updateStatistics(updatedTorrents) {
  const totalTorrents = updatedTorrents.map(nested => nested.length).reduce((a, b) => a + b, 0);
  const date = new Date().toISOString().replace(/T.*/, '');
  statistics[date] = (statistics[date] || 0) + totalTorrents;
}

module.exports = { scheduleUpdateSeeders }