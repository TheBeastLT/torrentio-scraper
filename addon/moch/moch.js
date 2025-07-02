import * as options from './options.js';
import * as realdebrid from './realdebrid.js';
import * as premiumize from './premiumize.js';
import * as alldebrid from './alldebrid.js';
import * as debridlink from './debridlink.js';
import * as easydebrid from './easydebrid.js';
import * as offcloud from './offcloud.js';
import * as torbox from './torbox.js';
import * as putio from './putio.js';
import StaticResponse, { isStaticUrl } from './static.js';
import { cacheWrapResolvedUrl } from '../lib/cache.js';
import { timeout } from '../lib/promises.js';
import { BadTokenError, streamFilename, AccessDeniedError, enrichMeta, AccessBlockedError } from './mochHelper.js';
import { createNamedQueue } from "../lib/namedQueue.js";

const RESOLVE_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const MIN_API_KEY_SYMBOLS = 15;
const TOKEN_BLACKLIST = [];
export const MochOptions = {
  realdebrid: {
    key: 'realdebrid',
    instance: realdebrid,
    name: "RealDebrid",
    shortName: 'RD',
    catalogs: ['']
  },
  premiumize: {
    key: 'premiumize',
    instance: premiumize,
    name: 'Premiumize',
    shortName: 'PM',
    catalogs: ['']
  },
  alldebrid: {
    key: 'alldebrid',
    instance: alldebrid,
    name: 'AllDebrid',
    shortName: 'AD',
    catalogs: ['']
  },
  debridlink: {
    key: 'debridlink',
    instance: debridlink,
    name: 'DebridLink',
    shortName: 'DL',
    catalogs: ['']
  },
  easydebrid: {
    key: 'easydebrid',
    instance: easydebrid,
    name: 'EasyDebrid',
    shortName: 'ED',
    catalogs: [],
    noDownloads: true
  },
  offcloud: {
    key: 'offcloud',
    instance: offcloud,
    name: 'Offcloud',
    shortName: 'OC',
    catalogs: ['']
  },
  torbox: {
    key: 'torbox',
    instance: torbox,
    name: 'TorBox',
    shortName: 'TB',
    catalogs: [`Torrents`, `Usenet`, `WebDL`]
  },
  putio: {
    key: 'putio',
    instance: putio,
    name: 'Put.io',
    shortName: 'Putio',
    catalogs: ['']
  }
};

const unrestrictQueues = {}
Object.values(MochOptions)
    .map(moch => moch.key)
    .forEach(mochKey => unrestrictQueues[mochKey] = createNamedQueue(50));

export function hasMochConfigured(config) {
  return Object.keys(MochOptions).find(moch => config?.[moch])
}

export async function applyMochs(streams, config) {
  if (!streams?.length || !hasMochConfigured(config)) {
    return streams;
  }
  return Promise.all(Object.keys(config)
      .filter(configKey => MochOptions[configKey])
      .map(configKey => MochOptions[configKey])
      .map(moch => {
        if (isInvalidToken(config[moch.key], moch.key)) {
          return { moch, error: BadTokenError };
        }
        return moch.instance.getCachedStreams(streams, config[moch.key], config.ip)
            .then(mochStreams => ({ moch, mochStreams }))
            .catch(rawError => {
              const error = moch.instance.toCommonError(rawError) || rawError;
              if (error === BadTokenError) {
                blackListToken(config[moch.key], moch.key);
              }
              return { moch, error };
            })
      }))
      .then(results => processMochResults(streams, config, results));
}

export async function resolve(parameters) {
  const moch = MochOptions[parameters.mochKey];
  if (!moch) {
    return Promise.reject(new Error(`Not a valid moch provider: ${parameters.mochKey}`));
  }

  if (!parameters.apiKey || !parameters.infoHash || !parameters.cachedEntryInfo) {
    return Promise.reject(new Error("No valid parameters passed"));
  }
  const id = `${parameters.ip}_${parameters.mochKey}_${parameters.apiKey}_${parameters.infoHash}_${parameters.fileIndex}`;
  const method = () => timeout(RESOLVE_TIMEOUT, cacheWrapResolvedUrl(id, () => moch.instance.resolve(parameters)))
      .catch(error => {
        console.warn(error);
        return StaticResponse.FAILED_UNEXPECTED;
      })
      .then(url => isStaticUrl(url) ? `${parameters.host}/${url}` : url);
  return unrestrictQueues[moch.key].wrap(id, method);
}

export async function getMochCatalog(mochKey, catalogId, config, ) {
  const moch = MochOptions[mochKey];
  if (!moch) {
    return Promise.reject(new Error(`Not a valid moch provider: ${mochKey}`));
  }
  if (isInvalidToken(config[mochKey], mochKey)) {
    return Promise.reject(new Error(`Invalid API key for moch provider: ${mochKey}`));
  }
  return moch.instance.getCatalog(config[moch.key], catalogId, config)
      .catch(rawError => {
        const commonError = moch.instance.toCommonError(rawError);
        if (commonError === BadTokenError) {
          blackListToken(config[moch.key], moch.key);
        }
        return commonError ? [] : Promise.reject(rawError);
      });
}

export async function getMochItemMeta(mochKey, itemId, config) {
  const moch = MochOptions[mochKey];
  if (!moch) {
    return Promise.reject(new Error(`Not a valid moch provider: ${mochKey}`));
  }

  return moch.instance.getItemMeta(itemId, config[moch.key], config.ip)
      .then(meta => enrichMeta(meta))
      .then(meta => {
        meta.videos.forEach(video => video.streams.forEach(stream => {
          if (!stream.url.startsWith('http')) {
            stream.url = `${config.host}/${moch.key}/${stream.url}/${streamFilename(video)}`
          }
          stream.behaviorHints = { bingeGroup: itemId }
        }))
        return meta;
      });
}

function processMochResults(streams, config, results) {
  const excludeDownloadLinks = options.excludeDownloadLinks(config);
  const cachedStreams = results.reduce((resultStreams, result) => {
    if (result?.mochStreams) {
      return populateCachedLinks(resultStreams, result, config)
    }
    const errorStream = errorStreamResponse(result.moch.key, result.error, config);
    if (errorStream) {
      resultStreams.push(errorStream);
    }
    return resultStreams;
  }, streams);
  const resultStreams = excludeDownloadLinks ? cachedStreams : populateDownloadLinks(cachedStreams, results, config);
  return resultStreams.filter(stream => stream.url);
}

function populateCachedLinks(streams, mochResult, config) {
  return streams.map(stream => {
    const cachedEntry = stream.infoHash && mochResult.mochStreams[`${stream.infoHash}@${stream.fileIdx}`];
    if (cachedEntry?.cached) {
      return {
        name: `[${mochResult.moch.shortName}+] ${stream.name}`,
        title: stream.title,
        url: `${config.host}/resolve/${mochResult.moch.key}/${cachedEntry.url}/${streamFilename(stream)}`,
        behaviorHints: stream.behaviorHints
      };
    }
    return stream;
  });
}

function populateDownloadLinks(streams, results, config) {
  const mochResults = results.filter(result => result.mochStreams);
  const torrentStreams = streams.filter(stream => stream.infoHash);
  const seededStreams = streams.filter(stream => !stream.title.includes('👤 0'));
  torrentStreams.forEach(stream => mochResults.forEach(mochResult => {
    const supportDownloads = !mochResult.moch.noDownloads;
    const cachedEntry = mochResult.mochStreams[`${stream.infoHash}@${stream.fileIdx}`];
    const isCached = cachedEntry?.cached;
    if (supportDownloads && !isCached && isHealthyStreamForDebrid(seededStreams, stream)) {
      streams.push({
        name: `[${mochResult.moch.shortName} download] ${stream.name}`,
        title: stream.title,
        url: `${config.host}/resolve/${mochResult.moch.key}/${cachedEntry.url}/${streamFilename(stream)}`,
        behaviorHints: stream.behaviorHints
      })
    }
  }));
  return streams;
}

function isHealthyStreamForDebrid(streams, stream) {
  const isZeroSeeders = stream.title.includes('👤 0');
  const is4kStream = stream.name.includes('4k');
  const isNotEnoughOptions = streams.length <= 5;
  return !isZeroSeeders || is4kStream || isNotEnoughOptions;
}

function isInvalidToken(token, mochKey) {
  return token.length < MIN_API_KEY_SYMBOLS || TOKEN_BLACKLIST.includes(`${mochKey}|${token}`);
}

function blackListToken(token, mochKey) {
  const tokenKey = `${mochKey}|${token}`;
  console.log(`Blacklisting invalid token: ${tokenKey}`)
  TOKEN_BLACKLIST.push(tokenKey);
}

function errorStreamResponse(mochKey, error, config) {
  if (error === BadTokenError) {
    return {
      name: `Torrentio\n${MochOptions[mochKey].shortName} error`,
      title: `Invalid ${MochOptions[mochKey].name} ApiKey/Token!`,
      url: `${config.host}/${StaticResponse.FAILED_ACCESS}`
    };
  }
  if (error === AccessDeniedError) {
    return {
      name: `Torrentio\n${MochOptions[mochKey].shortName} error`,
      title: `Expired/invalid ${MochOptions[mochKey].name} subscription!`,
      url: `${config.host}/${StaticResponse.FAILED_ACCESS}`
    };
  }
  if (error === AccessBlockedError) {
    return {
      name: `Torrentio\n${MochOptions[mochKey].shortName} error`,
      title: `Access to ${MochOptions[mochKey].name} is blocked!\nCheck your account or email.`,
      url: `${config.host}/${StaticResponse.FAILED_ACCESS}`
    };
  }
  return undefined;
}
