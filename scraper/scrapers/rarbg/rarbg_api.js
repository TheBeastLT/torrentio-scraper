const needle = require('needle');
const decode = require('magnet-uri');
const Promises = require('../../lib/promises');
const { defaultOptionsWithProxy } = require('./../../lib/request_helper');

const baseUrl = 'https://torrentapi.org/pubapi_v2.php';
const appId = 'node-rarbg-api';
const defaultTimeout = 30000;

let token;

const Options = {
  category: {
    MOVIES_XVID: [14],
    MOVIES_XVID_720P: [48],
    MOVIES_X264: [17],
    MOVIES_X264_1080P: [44],
    MOVIES_X264_720P: [45],
    MOVIES_X264_3D: [47],
    MOVIES_X264_4K: [50],
    MOVIES_X265_1080P: [54],
    MOVIES_X265_4K: [51],
    MOVIES_X265_4K_HDR: [52],
    MOVIES_FULL_BD: [42],
    MOVIES_BD_REMUX: [46],
    TV_EPISODES: [18],
    TV_UHD_EPISODES: [49],
    TV_HD_EPISODES: [41],
    MUSIC_MP3: [23],
    MUSIC_FLAC: [25],
    GAMES_PC_ISO: [27],
    GAMES_PC_RIP: [28],
    GAMES_PS3: [40],
    GAMES_XBOX_360: [32],
    SOFTWARE_PC_ISO: [33],
    EBOOKS: [35],
    XXX: [4],
  },
  sort: {
    LAST: 'last',
    SEEDERS: 'seeders',
    LEECHERS: 'leechers'
  },
  format: {
    JSON: 'json',
    JSON_EXTENDED: 'json_extended'
  },
  ranked: {
    TRUE: 1,
    FALSE: 0
  }
}

function search(imdbId, params = {}) {
  if (!imdbId) {
    return Promise.reject(new Error(`Must define imdbId`));
  }
  const parameters = {
    mode: 'search',
    search_imdb: imdbId,
    category: params.category && params.category.join(';') || null,
    limit: params.limit || 100,
    sort: params.sort || Options.sort.SEEDERS,
    min_seeders: params.min_seeders || undefined,
    min_leechers: params.min_leechers || undefined,
    format: params.format || Options.format.JSON_EXTENDED,
    ranked: params.ranked || Options.ranked.FALSE
  }

  return singleRequest(parameters).then(results => parseResults(results));
}

function browse(params = {}) {
  const parameters = {
    mode: 'list',
    category: params.category && params.category.join(';') || null,
    limit: params.limit || 100,
    sort: params.sort || Options.sort.LAST,
    min_seeders: params.min_seeders || undefined,
    min_leechers: params.min_leechers || undefined,
    format: params.format || Options.format.JSON_EXTENDED,
    ranked: params.ranked || Options.ranked.FALSE
  }

  return singleRequest(parameters).then(results => parseResults(results));
}

async function singleRequest(params = {}, config = {}, retries = 5) {
  const timeout = config.timeout || defaultTimeout;
  const options = { ...defaultOptionsWithProxy(), open_timeout: timeout, follow: 2 };
  params.token = await getToken();
  params.app_id = appId;

  Object.keys(params)
      .filter(key => params[key] === undefined || params[key] === null)
      .forEach(key => delete params[key]);

  return needle('get', baseUrl, params, options)
      .then(response => {
        if (response.body && response.body.error_code === 4) {
          // token expired
          token = undefined;
          return singleRequest(params, config);
        }
        if ((!response.body || [5, 20].includes(response.body.error_code)) && retries > 0) {
          // too many requests
          return Promises.delay(2100).then(() => singleRequest(params, config, retries - 1));
        }
        if (response.statusCode !== 200) {
          // something went wrong
          return Promise.reject(response.body || `Failed RARGB request with status=${response.statusCode}`);
        }

        return response.body;
      });
}

function parseResults(results) {
  if (!results || !Array.isArray(results.torrent_results)) {
    return Promise.reject(`Incorrect results ${JSON.stringify(results)}`)
  }
  return results.torrent_results.map(result => parseResult(result));
}

function parseResult(result) {
  return {
    title: result.title,
    infoHash: decode(result.download).infoHash,
    magnetLink: result.download,
    seeders: result.seeders,
    leechers: result.leechers,
    category: result.category,
    size: result.size,
    uploadDate: new Date(result.pubdate),
    imdbId: result.episode_info && result.episode_info.imdb
  }
}

async function getToken() {
  if (!token) {
    const options = { ...defaultOptionsWithProxy(), open_timeout: defaultTimeout };
    token = await needle('get', baseUrl, { get_token: 'get_token', app_id: appId }, options)
        .then(response => response.body.token);
  }
  return token;
}

module.exports = { search, browse, Options };
