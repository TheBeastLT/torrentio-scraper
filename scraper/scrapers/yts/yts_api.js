const axios = require('axios');
const Promises = require('../../lib/promises');
const { getRandomUserAgent } = require('./../../lib/requestHelper');

const defaultProxies = [
  'https://yts.mx'
];
const defaultTimeout = 30000;
const limit = 50;

function torrent(torrentId, config = {}, retries = 2) {
  if (!torrentId || retries === 0) {
    return Promise.reject(new Error(`Failed ${torrentId} search`));
  }

  return Promises.first(defaultProxies
          .map(proxyUrl => singleRequest(`${proxyUrl}/api/v2/movie_details.json?movie_id=${torrentId}`, config)))
      .then(body => parseResults(body))
      .catch(error => torrent(torrentId, config, retries - 1));
}

function search(query, config = {}, retries = 2) {
  if (!query || retries === 0) {
    return Promise.reject(new Error(`Failed ${query} search`));
  }

  return Promises.first(defaultProxies
          .map(proxyUrl => singleRequest(`${proxyUrl}/api/v2/list_movies.json?limit=${limit}&query_term=${query}`, config)))
      .then(results => parseResults(results))
      .catch(error => search(query, config, retries - 1));
}

function browse(config = {}, retries = 2) {
  if (retries === 0) {
    return Promise.reject(new Error(`Failed browse request`));
  }
  const page = config.page || 1;

  return Promises.first(defaultProxies
          .map(proxyUrl => singleRequest(`${proxyUrl}/api/v2/list_movies.json?limit=${limit}&page=${page}`, config)))
      .then(results => parseResults(results))
      .catch(error => browse(config, retries - 1));
}

function maxPage() {
  return Promises.first(defaultProxies
          .map(proxyUrl => singleRequest(`${proxyUrl}/api/v2/list_movies.json?limit=${limit}`)))
      .then(results => Math.round((results?.data?.movie_count || 0) / limit))
}

function singleRequest(requestUrl, config = {}) {
  const timeout = config.timeout || defaultTimeout;
  const options = { headers: { 'User-Agent': getRandomUserAgent() }, timeout: timeout };

  return axios.get(requestUrl, options)
      .then(response => {
        if (!response.data) {
          return Promise.reject(`No body: ${requestUrl}`);
        }
        return Promise.resolve(response.data);
      });
}

function parseResults(results) {
  if (!results || !results.data || (!results.data.movie && !Array.isArray(results.data.movies))) {
    console.log('Incorrect results: ', results);
    return Promise.reject('Incorrect results')
  }
  return (results.data.movies || [results.data.movie])
      .filter(movie => Array.isArray(movie.torrents))
      .map(movie => parseMovie(movie))
      .reduce((a, b) => a.concat(b), []);
}

function parseMovie(movie) {
  return movie.torrents.map(torrent => ({
    name: `${movie.title} ${movie.year} ${torrent.quality} ${formatType(torrent.type)} `,
    torrentId: `${movie.id}-${torrent.hash.trim().toLowerCase()}`,
    infoHash: torrent.hash.trim().toLowerCase(),
    torrentLink: torrent.url,
    seeders: torrent.seeds,
    size: torrent.size_bytes,
    uploadDate: new Date(torrent.date_uploaded_unix * 1000),
    imdbId: movie.imdb_code
  }));
}

function formatType(type) {
  if (type === 'web') {
    return 'WEBRip';
  }
  if (type === 'bluray') {
    return 'BluRay';
  }
  return type.toUpperCase();
}

module.exports = { torrent, search, browse, maxPage };