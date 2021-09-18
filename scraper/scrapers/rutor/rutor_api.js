const axios = require('axios');
const cheerio = require('cheerio');
const moment = require('moment');
const decode = require('magnet-uri');
const { defaultOptionsWithProxy } = require('../../lib/requestHelper');

const baseUrl = 'http://www.rutor.info';
const defaultTimeout = 10000;

const Categories = {
  FOREIGN_FILMS: '1',
  RUSSIAN_FILMS: '5',
  SCIENCE_FILMS: '12',
  FOREIGN_SERIES: '4',
  RUSSIAN_SERIES: '16',
  RUSSIAN_TV: '6',
  RUSSIAN_ANIMATION: '7',
  ANIME: '10',
  FOREIGN_RELEASES: '17'
};

function torrent(torrentId, config = {}, retries = 2, error = null) {
  if (!torrentId || retries === 0) {
    return Promise.reject(error || new Error(`Failed ${torrentId} search`));
  }

  return singleRequest(`${baseUrl}/torrent/${torrentId}`)
      .then((body) => parseTorrentPage(body, torrentId))
      .catch((err) => torrent(torrentId, config, retries - 1, err));
}

function search(query, retries = 2, error = null) {
  if (retries === 0) {
    return Promise.reject(error || new Error(`Failed browse request`));
  }

  return singleRequest(`${baseUrl}/search/0/0/0/0/${encodeURIComponent(query)}`)
      .then((body) => parseTableBody(body))
      .catch((err) => search(query, retries - 1, err));
}

function browse(config = {}, retries = 2, error = null) {
  if (retries === 0) {
    return Promise.reject(error || new Error(`Failed browse request`));
  }
  const page = config.page || 1;
  const category = config.category;

  return singleRequest(`${baseUrl}/browse/${page - 1}/${category}/0/0`)
      .then((body) => parseTableBody(body))
      .catch((err) => browse(config, retries - 1, err));
}

function files(torrentId) {
  return singleRequest(`${baseUrl}/descriptions/${torrentId}.files`)
      .then((body) => parseFiles(body));
}

function singleRequest(requestUrl) {
  const options = { ...defaultOptionsWithProxy(), timeout: defaultTimeout };

  return axios.get(requestUrl, options)
      .then((response) => {
        const body = response.data;
        if (!body) {
          throw new Error(`No body: ${requestUrl} with status ${response.status}`);
        } else if (body.includes('Access Denied')) {
          console.log(`Access Denied: ${requestUrl}`);
          throw new Error(`Access Denied: ${requestUrl}`);
        } else if (body.includes('502: Bad gateway') ||
            body.includes('403 Forbidden') ||
            body.includes('Origin DNS error')) {
          throw new Error(`Invalid body contents: ${requestUrl}`);
        }
        return body;
      });
}

function parseTableBody(body) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error('Failed loading body'));
    }

    const torrents = $('#index').find('tr:not(.backgr)').map((i, elem) => {
      const row = $(elem).find('td');
      const links = $(row[1]).find('a');
      const peers = $(row[row.length - 1]);
      const magnetLink = $(links[1]).attr('href');

      return {
        title: $(links[2]).text(),
        infoHash: decode(magnetLink).infoHash,
        magnetLink: magnetLink,
        torrentLink: $(links[0]).attr('href'),
        torrentId: $(links[2]).attr('href').match(/torrent\/(\d+)/)[1],
        seeders: parseInt(peers.find('.green').text()),
        leechers: parseInt(peers.find('.red').text()),
        uploadDate: parseRussianDate($(row[0]).text()),
        size: $(row[row.length - 2]).html().replace('&#xA0;', ' '),
      }
    }).get();

    resolve(torrents);
  });
}

function parseTorrentPage(body, torrentId) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(body);

    if (!$) {
      reject(new Error('Failed loading body'));
    }
    const rows = $('#details > tr')
    const details = $(rows[0]).find('td:nth-of-type(2)');
    const magnetLink = $('#download a:nth-of-type(1)').attr('href');
    const imdbIdMatch = details.html().match(/imdb\.com\/title\/(tt\d+)/i);

    const parsedTorrent = {
      title: $('#all h1').first().text(),
      torrentId: torrentId,
      infoHash: decode(magnetLink).infoHash,
      trackers: Array.from(new Set(decode(magnetLink).tr)).join(','),
      magnetLink: magnetLink,
      torrentLink: $('#download a:nth-of-type(2)').attr('href'),
      seeders: parseInt($(rows[rows.length - 8]).find('td:nth-of-type(2)').first().text(), 10),
      category: $('tr:contains(\'Категория\') a').first().attr('href').match(/\/([\w-]+)$/)[1],
      languages: parseLanguages(details.text()),
      size: parseSize($(rows[rows.length - 4]).find('td:nth-of-type(2)').text()),
      uploadDate: parseDate($(rows[rows.length - 5]).find('td:nth-of-type(2)').first().text()),
      imdbId: imdbIdMatch && imdbIdMatch[1]
    };
    resolve(parsedTorrent);
  });
}

function parseFiles(body) {
  if (!body) {
    throw new Error("No files in the body");
  }
  return body.split('\n')
      .map((item) => item.match(/<td>([^<]+)<\/td>/g).slice(1))
      .map((item, index) => ({
        fileIndex: index,
        name: item[0].replace(/^.+\//g, ''),
        path: item[0].replace(/^.+\//, ''),
        size: parseSize(item[1])
      }));
}

function parseDate(dateString) {
  const preparedDate = dateString.replace(/\s\(.*\)/, '')
  return moment(preparedDate, 'DD-MM-YYYY HH:mm:ss').toDate();
}

const russianMonths = {
  'Янв': 'Jan',
  'Фев': 'Feb',
  'Мар': 'Mar',
  'Апр': 'Apr',
  'Май': 'May',
  'Июн': 'Jun',
  'Июл': 'Jul',
  'Авг': 'Aug',
  'Сен': 'Sep',
  'Окт': 'Oct',
  'Ноя': 'Nov',
  'Дек': 'Dec'
};

function parseRussianDate(dateString) {
  const rusMonth = Object.keys(russianMonths).find(month => dateString.includes(month));
  const preparedDate = dateString.trim().replace(rusMonth, russianMonths[rusMonth]).replace(/\u00a0/g, ' ');
  return moment(preparedDate, 'DD MMM YY').toDate();
}

function parseSize(sizeString) {
  return parseInt(sizeString.match(/\((\d+) Bytes\)/)[1], 10);
}

const languageMatchers = {
  'russian': /(?:Язык|Звук|Аудио|audio|language).*(russian|\brus?\b|[Рр]усский)/i,
  'english': /(?:Язык|Звук|Аудио|audio|language).*(english|\beng?\b|[Аа]нглийский)/i,
  'ukrainian': /(?:Язык|Звук|Аудио|audio|language).*(ukrainian|\bukr\b|украинский)/i,
  'french': /(?:Язык|Звук|Аудио|audio|language).*(french|\bfr\b|французский)/i,
  'spanish': /(?:Язык|Звук|Аудио|audio|language).*(spanish|\bspa\b|испанский)/i,
  'italian': /(?:Язык|Звук|Аудио|audio|language).*(italian|\bita\b|итальянский)/i,
  'german': /(?:Язык|Звук|Аудио|audio|language).*(german|\bger\b|Немецкий)/i,
  'korean': /(?:Язык|Звук|Аудио|audio|language).*(korean|Корейский)/i,
  'arabic': /(?:Язык|Звук|Аудио|audio|language).*(arabic|Арабский)/i,
  'portuguese': /(?:Язык|Звук|Аудио|audio|language).*(portuguese|Португальский)/i,
  'japanese': /(?:Язык|Звук|Аудио|audio|language).*(japanese|\bjap\b|\bjp\b|[Яя]понский)/i,
}

function parseLanguages(details) {
  const subsInfoMatch = details.match(/\r?\n(Text|Текст)(?:\s?#?\d{1,2})?\r?\n/i);
  const detailsPart = subsInfoMatch ? details.substring(0, subsInfoMatch.index) : details;
  const matchedLanguages = Object.keys(languageMatchers).filter(lang => languageMatchers[lang].test(detailsPart));
  const languages = Array.from(new Set(['russian'].concat(matchedLanguages)));
  return languages.length > 4 ? 'multi-audio' : languages.join(',');
}

module.exports = { torrent, browse, search, Categories };
