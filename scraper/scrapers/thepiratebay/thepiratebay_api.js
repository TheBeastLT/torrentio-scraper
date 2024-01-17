const axios = require('axios');
const { escapeHTML } = require('../../lib/metadata');

const baseUrl = 'https://apibay.org';
const timeout = 5000;

const Categories = {
  AUDIO: {
    ALL: 100,
    MUSIC: 101,
    AUDIO_BOOKS: 102,
    SOUND_CLIPS: 103,
    FLAC: 104,
    OTHER: 199
  },
  VIDEO: {
    ALL: 200,
    MOVIES: 201,
    MOVIES_DVDR: 202,
    MUSIC_VIDEOS: 203,
    MOVIE_CLIPS: 204,
    TV_SHOWS: 205,
    HANDHELD: 206,
    MOVIES_HD: 207,
    TV_SHOWS_HD: 208,
    MOVIES_3D: 209,
    OTHER: 299
  },
  APPS: {
    ALL: 300,
    WINDOWS: 301,
    MAC: 302,
    UNIX: 303,
    HANDHELD: 304,
    IOS: 305,
    ANDROID: 306,
    OTHER_OS: 399
  },
  GAMES: {
    ALL: 400,
    PC: 401,
    MAC: 402,
    PSx: 403,
    XBOX360: 404,
    Wii: 405,
    HANDHELD: 406,
    IOS: 407,
    ANDROID: 408,
    OTHER: 499
  },
  PORN: {
    ALL: 500,
    MOVIES: 501,
    MOVIES_DVDR: 502,
    PICTURES: 503,
    GAMES: 504,
    MOVIES_HD: 505,
    MOVIE_CLIPS: 506,
    OTHER: 599
  },
  OTHER: {
    ALL: 600,
    E_BOOKS: 601,
    COMICS: 602,
    PICTURES: 603,
    COVERS: 604,
    PHYSIBLES: 605,
    OTHER: 699
  }
};

function torrent(torrentId, retries = 2) {
  if (!torrentId) {
    return Promise.reject(new Error('No valid torrentId provided'));
  }

  return _request(`t.php?id=${torrentId}`)
      .then(result => toTorrent(result))
      .catch(error => retries ? torrent(torrentId, retries - 1) : Promise.reject(error));
}

function search(keyword, config = {}, retries = 2) {
  if (!keyword) {
    return Promise.reject(new Error('No valid keyword provided'));
  }
  const q = keyword;
  const cat = config.category || Categories.VIDEO.ALL;

  return _request(`q.php?q=${q}&cat=${cat}`)
      .then(results => results.map((result) => toTorrent(result)))
      .catch(error => retries ? search(keyword, config, retries - 1) : Promise.reject(error));
}

function browse(config = {}, retries = 2) {
  const category = config.category || 0;
  const page = config.page - 1 || 0;

  return _request(`q.php?q=category:${category}:${page}`)
      .then(results => results.map((result) => toTorrent(result)))
      .catch(error => retries ? browse(config, retries - 1) : Promise.reject(error));
}

async function _request(endpoint) {
  const url = `${baseUrl}/${endpoint}`;
  return axios.get(url, { timeout: timeout })
      .then(response => {
        if (typeof response.data === 'object') {
          return response.data;
        }
        return Promise.reject(`Unexpected response body`);
      });
}

function toTorrent(result) {
  return {
    torrentId: result.id,
    name: escapeHTML(result.name),
    infoHash: result.info_hash.toLowerCase(),
    size: parseInt(result.size),
    seeders: parseInt(result.seeders),
    leechers: parseInt(result.leechers),
    subcategory: parseInt(result.category),
    uploadDate: new Date(result.added * 1000),
    imdbId: result.imdb || undefined,
    filesCount: result.num_files && parseInt(result.num_files) || undefined
  };
}

module.exports = { torrent, search, browse, Categories };
