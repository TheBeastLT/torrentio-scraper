const _ = require('lodash');
const needle = require('needle');
const nameToImdb = require('name-to-imdb');

const CINEMETA_URL = 'https://v3-cinemeta.strem.io';

function getMetadata(imdbId, type) {
  return needle('get', `${CINEMETA_URL}/meta/${type}/${imdbId}.json`, { open_timeout: 1000 })
      .then((response) => response.body)
      .then((body) => {
        if (body && body.meta && body.meta.name) {
          return {
            imdbId: imdbId,
            title: body.meta.name,
            year: body.meta.year,
            genres: body.meta.genres,
            episodeCount: body.meta.videos && _.chain(body.meta.videos)
                .countBy('season')
                .toPairs()
                .filter((pair) => pair[0] !== '0')
                .sortBy((pair) => parseInt(pair[0], 10))
                .map((pair) => pair[1])
                .value()
          };
        } else {
          console.log(`failed cinemeta query: Empty Body`);
          throw new Error('failed cinemeta query');
        }
      });
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

async function seriesMetadata(id) {
  const idInfo = id.split(':');
  const imdbId = idInfo[0];
  const season = parseInt(idInfo[1], 10);
  const episode = parseInt(idInfo[2], 10);

  const metadata = await getMetadata(imdbId, 'series');
  const title = escapeTitle(metadata.title);

  return {
    imdb: imdbId,
    title: hardcodedTitles[imdbId] || title,
    season: season,
    episode: episode,
    absoluteEpisode: hasEpisodeCount && metadata.episodeCount.slice(0, season - 1).reduce((a, b) => a + b, episode),
    genres: metadata.genres,
    isAnime: !metadata.genres.length || metadata.genres.includes('Animation')
  };
}

async function movieMetadata(id) {
  const metadata = await getMetadata(id, 'movie');

  return {
    imdb: id,
    title: escapeTitle(metadata.title),
    year: metadata.year,
    genres: metadata.genres,
    isAnime: !metadata.genres.length || metadata.genres.includes('Animation')
  };
}

async function getImdbId(info) {
  return new Promise((resolve, reject) => {
    nameToImdb(info, function(err, res) {
      if (res) {
        resolve(res);
      } else {
        reject(err || new Error('failed imdbId search'));
      }
    });
  });
}

module.exports = { getMetadata, movieMetadata, seriesMetadata, getImdbId };
