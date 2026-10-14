import axios from 'axios';
import { Type } from '../../addon/lib/types.js';

const CINEMETA_URL = 'https://v3-cinemeta.strem.io';
const KITSU_URL = 'https://anime-kitsu.strem.fun';
const TIMEOUT = parseInt(process.env.METADATA_TIMEOUT) || 10000;
const MAX_SIZE = 40;

export async function getMetas(ids, type) {
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
  const pageIds = ids.slice(0, MAX_SIZE);
  if (type === Type.ANIME) {
    const joinedIds = pageIds.map(id => `kitsu:${id}`).join(',');
    return `${KITSU_URL}/catalog/${type}/kitsu-anime-list/lastVideosIds=${joinedIds}.json`;
  }
  const joinedIds = pageIds.join(',');
  return `${CINEMETA_URL}/catalog/${type}/last-videos/lastVideosIds=${joinedIds}.json`;
}

function _sanitizeMeta(meta) {
  delete meta.videos;
  delete meta.credits_cast;
  delete meta.credits_crew;
  return meta;
}
