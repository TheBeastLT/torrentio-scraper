const needle = require('needle');
const nameToImdb = require('name-to-imdb');
const bing = require('nodejs-bing');
const { cacheWrapImdbId, cacheWrapMetadata } = require('./cache');

const CINEMETA_URL = 'https://v3-cinemeta.strem.io';
const KITSU_URL = 'https://anime-kitsu.now.sh';

function getMetadata(imdbId, type) {
  return cacheWrapMetadata(imdbId,
      () => needle('get', `${CINEMETA_URL}/meta/${type}/${imdbId}.json`, { open_timeout: 60000 })
          .then((response) => {
            const body = response.body;
            if (body && body.meta && body.meta.name) {
              return {
                imdbId: imdbId,
                title: body.meta.name,
                year: body.meta.year,
                genres: body.meta.genres,
                totalEpisodes: body.meta.videos && body.meta.videos
                    .filter(video => video.season > 0).length,
                episodeCount: body.meta.videos && Object.values(body.meta.videos
                    .filter((entry) => entry.season !== 0)
                    .sort((a, b) => a.season - b.season)
                    .reduce((map, next) => {
                      map[next.season] = map[next.season] + 1 || 1;
                      return map;
                    }, {}))
              };
            } else {
              throw new Error('No search results');
            }
          })
          .catch((error) => {
            throw new Error(`failed cinemeta query ${imdbId} due: ${error.message}`);
          }));
}

function getKitsuMetadata(kitsuId) {
  const key = kitsuId.startsWith('kitsu:') ? kitsuId : `kitsu:${kitsuId}`;
  return cacheWrapMetadata(key,
      () => needle('get', `${KITSU_URL}/meta/series/${key}.json`, { open_timeout: 60000 })
      .then((response) => {
        const body = response.body;
        if (body && body.meta && body.meta.id) {
          return {
            ...body.meta,
            videos: undefined,
            totalEpisodes: body.meta.videos && body.meta.videos
              .filter(video => video.season > 0).length
          };
        } else {
          throw new Error('No search results');
        }
      })
      .catch((error) => {
        throw new Error(`failed kitsu query ${kitsuId} due: ${error.message}`);
      }));
}

function escapeTitle(title, hyphenEscape = true) {
  return title.toLowerCase()
  .normalize('NFKD') // normalize non-ASCII characters
  .replace(/[\u0300-\u036F]/g, '')
  .replace(/&/g, 'and')
  .replace(hyphenEscape ? /[.,_+ -]+/g : /[.,_+ ]+/g, ' ') // replace dots, commas or underscores with spaces
  .replace(/[^\w- ()]/gi, '') // remove all non-alphanumeric chars
  .trim();
}

async function getImdbId(info) {
  const key = `${info.name}_${info.year}_${info.type}`;

  return cacheWrapImdbId(key,
      () => new Promise((resolve, reject) => {
        nameToImdb(info, function(err, res) {
          if (res) {
            resolve(res);
          } else {
            reject(err || new Error('failed imdbId search'));
          }
        });
      }).catch(() => bing.web(`${info.name} ${info.year || ''} ${info.type} imdb`)
          .then((results) => results
              .map((result) => result.link)
              .find(result => result.includes('imdb.com/title/'))
              .match(/imdb\.com\/title\/(tt\d+)/)[1])));
}

async function getKitsuId(title) {
  const query = title.replace(/[;]+/g, ' ').replace(/[,%']+/g, '');
  return cacheWrapImdbId(query,
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

module.exports = { escapeTitle, getMetadata, getImdbId, getKitsuMetadata, getKitsuId };
