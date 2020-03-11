const needle = require('needle');
const nameToImdb = require('name-to-imdb');
const bing = require('nodejs-bing');
const { cacheWrapImdbId, cacheWrapKitsuId, cacheWrapMetadata } = require('./cache');
const { Type } = require('./types');

const CINEMETA_URL = 'https://v3-cinemeta.strem.io';
const KITSU_URL = 'https://anime-kitsu.now.sh';
const TIMEOUT = 20000;

function getMetadata(id, type = Type.SERIES) {
  if (!id) {
    return Promise.reject("no valid id provided");
  }

  const key = id.match(/^\d+$/) ? `kitsu:${id}` : id;
  const metaType = type === Type.MOVIE ? Type.MOVIE : Type.SERIES;
  return cacheWrapMetadata(key,
      () => _requestMetadata(`${KITSU_URL}/meta/${metaType}/${key}.json`)
          .catch(() => _requestMetadata(`${CINEMETA_URL}/meta/${metaType}/${key}.json`))
          .catch((error) => {
            throw new Error(`failed metadata query ${key} due: ${error.message}`);
          }));
}

function _requestMetadata(url) {
  return needle('get', url, { open_timeout: TIMEOUT })
      .then((response) => {
        const body = response.body;
        if (body && body.meta && body.meta.id) {
          return {
            kitsuId: body.meta.kitsu_id,
            imdbId: body.meta.imdb_id,
            type: body.meta.type,
            title: body.meta.name,
            year: body.meta.year,
            country: body.meta.country,
            genres: body.meta.genres,
            videos: (body.meta.videos || [])
                .map((video) => video.imdbSeason
                    ? {
                      name: video.name,
                      season: video.season,
                      episode: video.episode,
                      imdbSeason: video.imdbSeason,
                      imdbEpisode: video.imdbEpisode
                    }
                    : {
                      name: video.name,
                      season: video.season,
                      episode: video.episode,
                      kitsuId: video.kitsu_id,
                      kitsuEpisode: video.kitsuEpisode,
                      released: video.released
                    }
                ),
            episodeCount: Object.values((body.meta.videos || [])
                .filter((entry) => entry.season !== 0)
                .sort((a, b) => a.season - b.season)
                .reduce((map, next) => {
                  map[next.season] = map[next.season] + 1 || 1;
                  return map;
                }, {})),
            totalCount: body.meta.videos && body.meta.videos
                .filter((entry) => entry.season !== 0).length
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
      .replace(/[;, ~\-]+/g, ' ') // replace dots, commas or underscores with spaces
      .replace(/[^\w ()+#@!']+/g, '') // remove all non-alphanumeric chars
      .trim();
}

async function getImdbId(info, type) {
  const name = escapeTitle(info.title);
  const year = info.year || info.date && info.date.slice(0, 4);
  const key = `${name}_${year}_${type}`;

  return cacheWrapImdbId(key,
      () => new Promise((resolve, reject) => {
        nameToImdb({ name, year, type }, function (err, res) {
          if (res) {
            resolve(res);
          } else {
            reject(err || new Error('failed imdbId search'));
          }
        });
      }).catch(() => bing.web(`${name} ${year || ''} ${type} imdb`)
          .then(results => results
              .map((result) => result.link)
              .find(result => result.includes('imdb.com/title/')))
          .then(result => result && result.match(/imdb\.com\/title\/(tt\d+)/))
          .then(match => match && match[1])));
}

async function getKitsuId(info) {
  const title = escapeTitle(info.title);
  const season = info.season > 1 ? ` S${info.season}` : '';
  const query = `${title}${season}`;

  return cacheWrapKitsuId(query,
      () => needle('get', `${KITSU_URL}/catalog/series/kitsu-anime-list/search=${query}.json`, { open_timeout: 60000 })
          .then((response) => {
            const body = response.body;
            if (body && body.metas && body.metas.length) {
              return body.metas[0].id.replace('kitsu:', '');
            } else {
              throw new Error('No search results');
            }
          }));
}

module.exports = { getMetadata, getImdbId, getKitsuId };
