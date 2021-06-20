const namedQueue = require('named-queue');
const options = require('./options');
const realdebrid = require('./realdebrid');
const premiumize = require('./premiumize');
const alldebrid = require('./alldebrid');
const debridlink = require('./debridlink');
const putio = require('./putio');
const StaticResponse = require('./static');
const { cacheWrapResolvedUrl } = require('../lib/cache');
const { timeout } = require('../lib/promises');
const { BadTokenError, streamFilename } = require('./mochHelper');

const RESOLVE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const MIN_API_KEY_SYMBOLS = 15;
const TOKEN_BLACKLIST = [];
const RESOLVER_HOST = process.env.RESOLVER_HOST || 'http://localhost:7050';
const MOCHS = {
  realdebrid: {
    key: 'realdebrid',
    instance: realdebrid,
    name: "RealDebrid",
    shortName: 'RD',
    catalog: true
  },
  premiumize: {
    key: 'premiumize',
    instance: premiumize,
    name: 'Premiumize',
    shortName: 'PM',
    catalog: true
  },
  alldebrid: {
    key: 'alldebrid',
    instance: alldebrid,
    name: 'AllDebrid',
    shortName: 'AD',
    catalog: true
  },
  debridlink: {
    key: 'debridlink',
    instance: debridlink,
    name: 'DebridLink',
    shortName: 'DL',
    catalog: true
  },
  putio: {
    key: 'putio',
    instance: putio,
    name: 'Put.io',
    shortName: 'Putio',
    catalog: false
  }
};

const unrestrictQueue = new namedQueue((task, callback) => task.method()
    .then(result => callback(false, result))
    .catch((error => callback(error))), 5);

async function applyMochs(streams, config) {
  if (!streams || !streams.length || !Object.keys(MOCHS).find(moch => config[moch])) {
    return streams;
  }
  return Promise.all(Object.keys(config)
      .filter(configKey => MOCHS[configKey])
      .map(configKey => MOCHS[configKey])
      .map(moch => {
        if (isInvalidToken(config[moch.key], moch.key)) {
          return { moch, error: BadTokenError };
        }
        return moch.instance.getCachedStreams(streams, config[moch.key])
            .then(mochStreams => ({ moch, mochStreams }))
            .catch(error => {
              if (error === BadTokenError) {
                blackListToken(config[moch.key], moch.key);
              }
              return { moch, error };
            })
      }))
      .then(results => processMochResults(streams, config, results));
}

async function resolve(parameters) {
  const moch = MOCHS[parameters.mochKey];
  if (!moch) {
    return Promise.reject(`Not a valid moch provider: ${parameters.mochKey}`);
  }

  if (!parameters.apiKey || !parameters.infoHash || !parameters.cachedEntryInfo) {
    return Promise.reject("No valid parameters passed");
  }
  const id = `${parameters.mochKey}_${parameters.apiKey}_${parameters.infoHash}_${parameters.fileIndex}`;
  const method = () => timeout(RESOLVE_TIMEOUT, cacheWrapResolvedUrl(id, () => moch.instance.resolve(parameters)))
      .catch(error => {
        console.warn(error);
        return StaticResponse.FAILED_UNEXPECTED;
      });
  return new Promise(((resolve, reject) => {
    unrestrictQueue.push({ id, method }, (error, result) => result ? resolve(result) : reject(error));
  }));
}

async function getMochCatalog(mochKey, config) {
  const moch = MOCHS[mochKey];
  if (!moch) {
    return Promise.reject(`Not a valid moch provider: ${mochKey}`);
  }
  if (isInvalidToken(config[mochKey], mochKey)) {
    return Promise.reject(`Invalid API key for moch provider: ${mochKey}`);
  }
  return moch.instance.getCatalog(config[moch.key], config.skip, config.ip);
}

async function getMochItemMeta(mochKey, itemId, config) {
  const moch = MOCHS[mochKey];
  if (!moch) {
    return Promise.reject(`Not a valid moch provider: ${mochKey}`);
  }

  return moch.instance.getItemMeta(itemId, config[moch.key], config.ip)
      .then(meta => {
        meta.videos.forEach(video => {
          if (!video.stream.url.startsWith('http')) {
            video.stream.url = `${RESOLVER_HOST}/${moch.key}/${video.stream.url}`
          }
          video.streams = [video.stream];
        });
        return meta;
      });
}

function processMochResults(streams, config, results) {
  const errorResults = results.filter(result => result && result.error === BadTokenError);
  if (errorResults.length) {
    return errorResults.map(result => badTokenStreamResponse(result.moch.key))
  }

  const includeTorrentLinks = options.includeTorrentLinks(config);
  const excludeDownloadLinks = options.excludeDownloadLinks(config);
  const mochResults = results.filter(result => result && result.mochStreams);

  const cachedStreams = mochResults
      .reduce((resultStreams, mochResult) => populateCachedLinks(resultStreams, mochResult), streams);
  const resultStreams = excludeDownloadLinks ? cachedStreams : populateDownloadLinks(cachedStreams, mochResults);
  return includeTorrentLinks ? resultStreams : resultStreams.filter(stream => stream.url);
}

function populateCachedLinks(streams, mochResult) {
  return streams.map(stream => {
    const cachedEntry = stream.infoHash && mochResult.mochStreams[stream.infoHash];
    if (cachedEntry && cachedEntry.cached) {
      return {
        name: `[${mochResult.moch.shortName}+] ${stream.name}`,
        title: stream.title,
        url: `${RESOLVER_HOST}/${mochResult.moch.key}/${cachedEntry.url}/${streamFilename(stream)}`,
        behaviorHints: stream.behaviorHints
      };
    }
    return stream;
  });
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
                url: `${RESOLVER_HOST}/${mochResult.moch.key}/${cachedEntry.url}/${streamFilename(stream)}`,
                behaviorHints: stream.behaviorHints
              })
            }
          }));
  return streams;
}

function isInvalidToken(token, mochKey) {
  return token.length < MIN_API_KEY_SYMBOLS || TOKEN_BLACKLIST.includes(`${mochKey}|${token}`);
}

function blackListToken(token, mochKey) {
  const tokenKey = `${mochKey}|${token}`;
  console.log(`Blacklisting invalid token: ${tokenKey}`)
  TOKEN_BLACKLIST.push(tokenKey);
}

function badTokenStreamResponse(mochKey) {
  return {
    name: `Torrentio\n${MOCHS[mochKey].shortName} error`,
    title: `Invalid ${MOCHS[mochKey].name} ApiKey/Token!`,
    url: StaticResponse.FAILED_ACCESS
  };
}

module.exports = { applyMochs, getMochCatalog, getMochItemMeta, resolve, MochOptions: MOCHS }
