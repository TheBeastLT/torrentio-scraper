const RealDebridClient = require('real-debrid-api');
const isVideo = require('../lib/video');

const RESOLVER_HOST = process.env.RESOLVER_HOST || 'http://localhost:7000';

async function applyMoch(streams, apiKey) {
  const RD = new RealDebridClient(apiKey);
  const hashes = streams.map(stream => stream.infoHash);
  const available = await RD.torrents.instantAvailability(hashes)
      .catch(error => {
        console.warn('Failed cached torrent availability request: ', error);
        return undefined;
      });
  if (available) {
    streams.forEach(stream => {
      const cachedEntry = available[stream.infoHash];
      const cachedIds = getCachedFileIds(stream.fileIdx, cachedEntry).join(',');
      if (cachedIds.length) {
        stream.name = `[RD Cached]\n${stream.name}`;
        stream.url = `${RESOLVER_HOST}/realdebrid/${apiKey}/${stream.infoHash}/${cachedIds}/${stream.fileIdx}`;
        delete stream.infoHash;
        delete stream.fileIndex;
      }
    });
  }

  return streams;
}

function getCachedFileIds(fileIndex, hosterResults) {
  if (!hosterResults || Array.isArray(hosterResults)) {
    return [];
  }
  // if not all cached files are videos, then the torrent will be zipped to a rar
  const cachedTorrents = Object.values(hosterResults)
      .reduce((a, b) => a.concat(b), [])
      .filter(cached => !Number.isInteger(fileIndex) && Object.keys(cached).length || cached[fileIndex + 1])
      .filter(cached => Object.values(cached).every(file => isVideo(file.filename)))
      .map(cached => Object.keys(cached))
      .sort((a, b) => b.length - a.length);
  return cachedTorrents.length && cachedTorrents[0] || [];
}

module.exports = { applyMoch };