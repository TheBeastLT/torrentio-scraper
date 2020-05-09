const realdebrid = require('./realdebrid');
const premiumize = require('./premiumize');

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
  }
};

async function applyMochs(streams, config) {
  if (!streams || !streams.length) {
    return streams;
  }

  return Promise.all(Object.keys(config)
      .filter(configKey => MOCHS[configKey])
      .map(configKey => MOCHS[configKey])
      .map(moch => moch.instance.getCachedStreams(streams, config[moch.key])
          .then(cachedStreams => ({ moch, cachedStreams }))
          .catch(error => console.warn(error))))
      .then(mochResults => mochResults
          .filter(result => result && result.cachedStreams)
          .reduce((resultStreams, { moch, cachedStreams }) => {
            resultStreams
                .filter(stream => stream.infoHash)
                .filter(stream => cachedStreams[stream.infoHash])
                .forEach(stream => {
                  stream.name = `[${moch.shortName}+] ${stream.name}`;
                  stream.url = `${RESOLVER_HOST}/${moch.key}/${cachedStreams[stream.infoHash]}`;
                  delete stream.infoHash;
                  delete stream.fileIndex;
                });
            return resultStreams;
          }, streams));
}

async function resolve(parameters) {
  const moch = MOCHS[parameters.mochKey];
  if (!moch) {
    return Promise.reject('Not a valid moch provider');
  }
  return moch.instance.resolve(parameters);
}

module.exports = { applyMochs, resolve }