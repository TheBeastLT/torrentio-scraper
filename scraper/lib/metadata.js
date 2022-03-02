const axios = require('axios');
const nameToImdb = require('name-to-imdb');
const googleSr = require('google-sr');
const he = require('he');
const { cacheWrapImdbId, cacheWrapKitsuId, cacheWrapMetadata } = require('./cache');
const { Type } = require('./types');

const CINEMETA_URL = 'https://v3-cinemeta.strem.io';
const KITSU_URL = 'https://anime-kitsu.strem.fun';
const TIMEOUT = 20000;

function getMetadata(id, type = Type.SERIES) {
  if (!id) {
    return Promise.reject("no valid id provided");
  }

  const key = Number.isInteger(id) || id.match(/^\d+$/) ? `kitsu:${id}` : id;
  const metaType = type === Type.MOVIE ? Type.MOVIE : Type.SERIES;
  return cacheWrapMetadata(key, () => _requestMetadata(`${KITSU_URL}/meta/${metaType}/${key}.json`)
      .catch(() => _requestMetadata(`${CINEMETA_URL}/meta/${metaType}/${key}.json`))
      .catch(() => {
        // try different type in case there was a mismatch
        const otherType = metaType === Type.MOVIE ? Type.SERIES : Type.MOVIE;
        return _requestMetadata(`${CINEMETA_URL}/meta/${otherType}/${key}.json`)
      })
      .catch((error) => {
        throw new Error(`failed metadata query ${key} due: ${error.message}`);
      }));
}

function _requestMetadata(url) {
  return axios.get(url, { timeout: TIMEOUT })
      .then((response) => {
        const body = response.data;
        if (body && body.meta && (body.meta.imdb_id || body.meta.kitsu_id)) {
          return {
            kitsuId: body.meta.kitsu_id,
            imdbId: body.meta.imdb_id,
            type: body.meta.type,
            title: body.meta.name,
            year: body.meta.year,
            country: body.meta.country,
            genres: body.meta.genres,
            status: body.meta.status,
            videos: (body.meta.videos || [])
                .map((video) => Number.isInteger(video.imdbSeason)
                    ? {
                      name: video.name || video.title,
                      season: video.season,
                      episode: video.episode,
                      imdbSeason: video.imdbSeason,
                      imdbEpisode: video.imdbEpisode
                    }
                    : {
                      name: video.name || video.title,
                      season: video.season,
                      episode: video.episode,
                      kitsuId: video.kitsu_id,
                      kitsuEpisode: video.kitsuEpisode,
                      released: video.released
                    }
                ),
            episodeCount: Object.values((body.meta.videos || [])
                .filter((entry) => entry.season !== 0 && entry.episode !== 0)
                .sort((a, b) => a.season - b.season)
                .reduce((map, next) => {
                  map[next.season] = map[next.season] + 1 || 1;
                  return map;
                }, {})),
            totalCount: body.meta.videos && body.meta.videos
                .filter((entry) => entry.season !== 0 && entry.episode !== 0).length
          };
        } else {
          throw new Error('No search results');
        }
      });
}

function escapeTitle(title) {
  return title.toLowerCase()
      .normalize('NFKD') // normalize non-ASCII characters
      .replace(/[\u0300-\u036F]/g, '')
      .replace(/&/g, 'and')
      .replace(/[;, ~./]+/g, ' ') // replace dots, commas or underscores with spaces
      .replace(/[^\w \-()+#@!'\u0400-\u04ff]+/g, '') // remove all non-alphanumeric chars
      .replace(/^\d{1,2}[.#\s]+(?=(?:\d+[.\s]*)?[\u0400-\u04ff])/i, '') // remove russian movie numbering
      .replace(/\s{2,}/, ' ') // replace multiple spaces
      .trim();
}

function escapeHTML(title) {
  return he.decode(title)
      .replace(/&amp;/g, "&");
}

async function getImdbId(info, type) {
  const name = escapeTitle(info.title);
  const year = info.year || info.date && info.date.slice(0, 4);
  const key = `${name}_${year}_${type}`;
  const query = `${name} ${year || ''} ${type} imdb`;

  return cacheWrapImdbId(key,
      () => new Promise((resolve, reject) => {
        nameToImdb({ name: encodeURIComponent(name), year: info.year, type }, function (err, res) {
          if (res) {
            resolve(res);
          } else {
            reject(err || new Error('failed imdbId search'));
          }
        });
      }).catch(() => googleSr.search(query)
          .then(response => response.length ? response : Promise.reject('No results'))
          .then(results => results
              .map(result => result.Link)
              .find(result => result.includes('imdb.com/title/')))
          .then(result => result && result.match(/imdb\.com\/title\/(tt\d+)/))
          .then(match => match && match[1])))
      .then(imdbId => imdbId && 'tt' + imdbId.replace(/tt0*([1-9][0-9]*)$/, '$1').padStart(7, '0'));
}

async function getKitsuId(info) {
  const title = escapeTitle(info.title.replace(/\s\|\s.*/, ''));
  const year = info.year ? ` ${info.year}` : '';
  const season = info.season > 1 ? ` S${info.season}` : '';
  const key = `${title}${year}${season}`;
  const query = encodeURIComponent(key);

  return cacheWrapKitsuId(key,
      () => axios.get(`${KITSU_URL}/catalog/series/kitsu-anime-list/search=${query}.json`, { timeout: 60000 })
          .then((response) => {
            const body = response.data;
            if (body && body.metas && body.metas.length) {
              return body.metas[0].id.replace('kitsu:', '');
            } else {
              throw new Error('No search results');
            }
          }));
}

async function isEpisodeImdbId(imdbId) {
  if (!imdbId) {
    return false;
  }
  return axios.get(`https://www.imdb.com/title/${imdbId}/`, { timeout: 10000 })
      .then(response => !!(response.data && response.data.includes('video.episode')))
      .catch((err) => false);
}

module.exports = { getMetadata, getImdbId, getKitsuId, isEpisodeImdbId, escapeHTML, escapeTitle };
