const Bottleneck = require('bottleneck');
const scrapers = require('./scrapers');
const repository = require('../lib/repository')
const { delay } = require('../lib/promises')
const { updateCurrentSeeders } = require('../lib/torrent')
const { updateTorrentSeeders } = require('../lib/torrentEntries')

const DELAY = 15 * 1000; // 15 seconds
const limiter = new Bottleneck({ maxConcurrent: 20, minTime: 250 });
const forceSeedersLimiter = new Bottleneck({ maxConcurrent: 5 });

function scheduleUpdateSeeders() {
  console.log('Starting seeders update...')
  return repository.getUpdateSeedersTorrents()
      .then(torrents => Promise.all(torrents.map(torrent => limiter.schedule(() => _updateSeeders(torrent)))))
      .then(() => console.log('Finished seeders update'))
      .catch(error => console.warn('Failed seeders update: ', error))
      .then(() => delay(DELAY))
      .then(() => scheduleUpdateSeeders());
}

async function _updateSeeders(torrent) {
  const provider = await scrapers.find(provider => provider.name === torrent.provider);
  if (!provider) {
    console.log(`No provider found for ${torrent.provider} [${torrent.infoHash}]`)
    return Promise.resolve();
  }
  const updatedTorrents = await provider.scraper.updateSeeders(torrent, getImdbIdsMethod(torrent))
      .then(updated => Array.isArray(updated) ? updated : [updated])
      .catch(() => []);

  if (!updatedTorrents.find(updated => updated.infoHash === torrent.infoHash)) {
    await forceSeedersLimiter.schedule(() => updateCurrentSeeders(torrent))
        .then(updated => updatedTorrents.push(updated));
  }

  return Promise.all(updatedTorrents.map(updated => updateTorrentSeeders(updated)))
}

async function getImdbIdsMethod(torrent) {
  return () => repository.getFiles(torrent)
      .then(files => files.map(file => file.imdbId).filter(id => id))
      .then(ids => Array.from(new Set(ids)));
}

module.exports = { scheduleUpdateSeeders }