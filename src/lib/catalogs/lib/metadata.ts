import axios from 'axios';
import { Type } from '../../addon/lib/types.js';

const CINEMETA_URL = 'https://v3-cinemeta.strem.io';
const KITSU_URL = 'https://anime-kitsu.strem.fun';
const TIMEOUT = 30000;
const MAX_SIZE = 40;

export async function getMetas(ids: string[], type: any) {
  if (!ids.length || !type) {
    return [];
  }

  return _requestMetadata(ids, type)
    .catch((error) => {
      throw new Error(`failed metadata ${type} query due: ${error.message}`);
    });
}

async function _requestMetadata(ids: string[], type: any) {
  const url = _getUrl(ids, type);
  const response = await axios.get(url, { timeout: TIMEOUT });
  const metas = response?.data?.metas || response?.data?.metasDetailed || [];
  const metas_1 = metas.filter((meta: any) => meta);
  return metas_1.map((meta_1: { videos: any; credits_cast: any; credits_crew: any; }) => _sanitizeMeta(meta_1));
}

function _getUrl(ids: string[], type: string) {
  const joinedIds = ids.slice(0, MAX_SIZE).join(',');
  if (type === Type.ANIME) {
    return `${KITSU_URL}/catalog/${type}/kitsu-anime-list/lastVideosIds=${joinedIds}.json`;
  }
  return `${CINEMETA_URL}/catalog/${type}/last-videos/lastVideosIds=${joinedIds}.json`;
}

function _sanitizeMeta(meta: { videos: any; credits_cast: any; credits_crew: any; }) {
  delete meta.videos;
  delete meta.credits_cast;
  delete meta.credits_crew;
  return meta;
}
