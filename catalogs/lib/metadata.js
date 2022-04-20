const axios = require('axios');
const { Type } = require('../../addon/lib/types');

const CINEMETA_URL = 'https://v3-cinemeta.strem.io';
const KITSU_URL = 'https://anime-kitsu.strem.fun';
const TIMEOUT = 30000;
const MAX_SIZE = 50;

function getMetas(ids, type) {
  if (!ids.length || !type) {
    return [];
  }

  return _requestMetadata(ids, type)
      .catch((error) => {
        throw new Error(`failed metadata ${type} query due: ${error.message}`);
      });
}

function _requestMetadata(ids, type) {
  const url = _getUrl(ids, type);
  return axios.get(url, { timeout: TIMEOUT })
      .then(response => response?.data?.metas || response?.data?.metasDetailed || [])
      .then(metas => metas.filter(meta => meta))
      .then(metas => metas.map(meta => _sanitizeMeta(meta)));
}

function _getUrl(ids, type) {
  const joinedIds = ids.slice(0, MAX_SIZE).join(',');
  if (type === Type.ANIME) {
    return `${KITSU_URL}/catalog/${type}/kitsu-anime-list/lastVideosIds=${joinedIds}.json`
  }
  return `${CINEMETA_URL}/catalog/${type}/last-videos/lastVideosIds=${joinedIds}.json`
}

function _sanitizeMeta(meta) {
  delete meta.videos;
  delete meta.credits_cast;
  delete meta.credits_crew;
  return meta;
}

module.exports = { getMetas };
