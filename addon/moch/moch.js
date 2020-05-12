const namedQueue = require('named-queue');
const options = require('./options');
const realdebrid = require('./realdebrid');
const premiumize = require('./premiumize');
const alldebrid = require('./alldebrid');
const putio = require('./putio');
const StaticResponse = require('./static');
const { cacheWrapResolvedUrl } = require('../lib/cache');

const RESOLVER_HOST = process.env.RESOLVER_HOST || 'http://localhost:7050';
const MOCHS = {
  'realdebrid': {
    key: 'realdebrid',
    instance: realdebrid,
    shortName: 'RD'
  },
  'premiumize': {
    key: 'premiumize',
    instance: premiumize,
    shortName: 'PM'
  },
  'alldebrid': {
    key: 'alldebrid',
    instance: alldebrid,
    shortName: 'AD'
  },
  'putio': {
    key: 'putio',
    instance: putio,
    shortName: 'Putio'
  }
};

const unrestrictQueue = new namedQueue((task, callback) => task.method()
    .then(result => callback(false, result))
    .catch((error => callback(error))));

async function applyMochs(streams, config) {
  if (!streams || !streams.length) {
    return streams;
  }

  const onlyCached = options.onlyCachedLinks(config);
  const onlyCachedIfAvailable = options.onlyCachedLinksIfAvailable(config);
  const includeDownloadLinks = options.includeDownloadLinks(config);

  const configuredMochs = Object.keys(config)
      .filter(configKey => MOCHS[configKey])
      .map(configKey => MOCHS[configKey]);
  const mochResults = await Promise.all(configuredMochs
      .map(moch => moch.instance.getCachedStreams(streams, config[moch.key])
          .then(mochStreams => ({ moch, mochStreams }))
          .catch(error => console.warn(error))))
      .then(results => results.filter(result => result && result.mochStreams));
  const cachedStreams = mochResults
      .reduce((resultStreams, mochResult) => populateCachedLinks(resultStreams, mochResult), streams);
  const hasCachedStreams = cachedStreams.find(stream => stream.url);

  const resultStreams = includeDownloadLinks ? populateDownloadLinks(cachedStreams, mochResults) : cachedStreams;
  return onlyCached || onlyCachedIfAvailable && hasCachedStreams
      ? resultStreams.filter(stream => stream.url)
      : resultStreams;
}

async function resolve(parameters) {
  const moch = MOCHS[parameters.mochKey];
  if (!moch) {
    return Promise.reject('Not a valid moch provider');
  }

  if (!parameters.apiKey || !parameters.infoHash || !parameters.cachedEntryInfo) {
    return Promise.reject("No valid parameters passed");
  }
  const id = `${parameters.mochKey}_${parameters.ip}_${parameters.infoHash}_${parameters.fileIndex}`;
  const method = () => cacheWrapResolvedUrl(id, () => moch.instance.resolve(parameters))
      .catch(error => {
        console.warn(error);
        return StaticResponse.FAILED_UNEXPECTED;
      });

  return new Promise(((resolve, reject) => {
    unrestrictQueue.push({ id, method }, (error, result) => result ? resolve(result) : reject(error));
  }));
}

function populateCachedLinks(streams, mochResult) {
  streams
      .filter(stream => stream.infoHash)
      .forEach(stream => {
        const cachedEntry = mochResult.mochStreams[stream.infoHash];
        if (cachedEntry && cachedEntry.cached) {
          stream.name = `[${mochResult.moch.shortName}+] ${stream.name}`;
          stream.url = `${RESOLVER_HOST}/${mochResult.moch.key}/${cachedEntry.url}`;
          delete stream.infoHash;
          delete stream.fileIndex;
        }
      });
  return streams;
}

function populateDownloadLinks(streams, mochResults) {
  streams
      .filter(stream => stream.infoHash)
      .forEach(stream => mochResults
          .forEach(mochResult => {
            const cachedEntry = mochResult.mochStreams[stream.infoHash];
            if (!cachedEntry || !cachedEntry.cached) {
              streams.push({
                name: `[${mochResult.moch.shortName} download] ${stream.name}`,
                title: stream.title,
                url: `${RESOLVER_HOST}/${mochResult.moch.key}/${cachedEntry.url}`
              })
            }
          }));
  return streams;
}

module.exports = { applyMochs, resolve }