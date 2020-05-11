const namedQueue = require('named-queue');
const options = require('./options');
const realdebrid = require('./realdebrid');
const premiumize = require('./premiumize');
const alldebrid = require('./alldebrid');
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
  }
};

const unrestrictQueue = new namedQueue((task, callback) => task.method()
    .then(result => callback(false, result))
    .catch((error => callback(error))));

async function applyMochs(streams, config) {
  if (!streams || !streams.length) {
    return streams;
  }
  const includeDownloadLinks = options.includeDownloadLinks(config);

  return Promise.all(Object.keys(config)
      .filter(configKey => MOCHS[configKey])
      .map(configKey => MOCHS[configKey])
      .map(moch => moch.instance.getCachedStreams(streams, config[moch.key])
          .then(mochStreams => ({ moch, mochStreams }))
          .catch(error => console.warn(error))))
      .then(mochResults => mochResults
          .filter(result => result && result.mochStreams)
          .reduce((resultStreams, { moch, mochStreams }) => {
            resultStreams
                .filter(stream => stream.infoHash)
                .filter(stream => mochStreams[stream.infoHash])
                .forEach(stream => {
                  const cachedEntry = mochStreams[stream.infoHash];
                  if (cachedEntry.cached) {
                    stream.name = `[${moch.shortName}+] ${stream.name}`;
                    stream.url = `${RESOLVER_HOST}/${moch.key}/${cachedEntry.url}`;
                    delete stream.infoHash;
                    delete stream.fileIndex;
                  } else if (includeDownloadLinks) {
                    resultStreams.push({
                      name: `[${moch.shortName} download] ${stream.name}`,
                      title: stream.title,
                      url: `${RESOLVER_HOST}/${moch.key}/${cachedEntry.url}`
                    })
                  }
                });
            return resultStreams;
          }, streams));
}

async function resolve(parameters) {
  const moch = MOCHS[parameters.mochKey];
  if (!moch) {
    return Promise.reject('Not a valid moch provider');
  }

  if (!parameters.apiKey || !parameters.infoHash || !parameters.cachedEntryInfo) {
    return Promise.reject("No valid parameters passed");
  }
  const id = `${parameters.mochKey}_${parameters.apiKey}_${parameters.infoHash}_${parameters.fileIndex}`;
  const method = () => cacheWrapResolvedUrl(id, () => moch.instance.resolve(parameters))
      .catch(error => {
        console.warn(error);
        return StaticResponse.FAILED_UNEXPECTED;
      });

  return new Promise(((resolve, reject) => {
    unrestrictQueue.push({ id, method }, (error, result) => result ? resolve(result) : reject(error));
  }));
}

module.exports = { applyMochs, resolve }