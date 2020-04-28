const cheerio = require('cheerio');
const needle = require('needle');
const moment = require('moment');
const Promises = require('../../lib/promises');

const defaultUrl = 'https://horriblesubs.info';
const defaultTimeout = 10000;

function allShows(config = {}) {
  return _getContent('/shows/', config)
      .then(($) => $('div[class="ind-show"]')
          .map((index, element) => $(element).children('a'))
          .map((index, element) => ({
            title: element.attr('title'),
            url: `${config.proxyUrl || defaultUrl}${element.attr('href')}`
          })).get());
}

async function showData(showInfo, config = {}) {
  const showEndpoint = (showInfo.url || showInfo).match(/\/show.+/)[0];
  const title = showInfo.title;
  const showId = await _getShowId(showEndpoint);
  const packEntries = await _getShowEntries(showId, title, 'batch', config);
  const singleEntries = await _getShowEntries(showId, title, 'show', config);

  return {
    title: title,
    url: showInfo.url || showInfo,
    showId: showId,
    singleEpisodes: singleEntries,
    packEpisodes: packEntries
  };
}

async function getLatestEntries(config = {}) {
  return _getAllLatestEntries(config)
      .then((entries) => Promises.sequence(entries.map((entry) => () => _findLatestEntry(entry, config))))
      .then((entries) => entries.filter((entry) => entry))
}

function _getContent(endpoint, config = {},) {
  const baseUrl = config.proxyUrl || defaultUrl;
  const timeout = config.timeout || defaultTimeout;
  const url = endpoint.startsWith('http')
      ? endpoint.replace(/https?:\/\/[^/]+/, baseUrl)
      : `${baseUrl}${endpoint}`;

  return needle('get', url, { open_timeout: timeout, follow: 2 })
      .then((response) => response.body)
      .then((body) => cheerio.load(body));
}

function _getShowId(showEndpoint) {
  return _getContent(showEndpoint)
      .then($ => $('div.entry-content').find('script').html().match(/var hs_showid = (\d+)/)[1]);
}

function _getShowEntries(animeId, animeTitle, type, config) {
  return _getAllEntries(animeId, type, config)
      .then((entries) => entries.filter((entry) => entry.title === animeTitle));
}

function _getAllEntries(animeId, type, config, page = 0, autoExtend = true) {
  const entriesEndpoint = `/api.php?method=getshows&type=${type}&showid=${animeId}&nextid=${page}`;
  return _getEntries(entriesEndpoint, config)
      .then((entries) => !autoExtend || !entries.length ? entries :
          _getAllEntries(animeId, type, config, page + 1)
              .then((nextEntries) => entries.concat(nextEntries)));
}

function _getEntries(endpoint, config) {
  return _getContent(endpoint, config)
      .then(($) => $('div[class="rls-info-container"]')
          .map((index, element) => ({
            title: $(element).find('a[class="rls-label"]').contents()
                .filter((i, el) => el.nodeType === 3).first().text().trim(),
            episode: $(element).find('a[class="rls-label"]').find('strong').text(),
            uploadDate: _parseDate($(element).find('a[class="rls-label"]').find('span[class="rls-date"]').text()),
            mirrors: $(element).find('div[class="rls-links-container"]').children()
                .map((indexLink, elementLink) => ({
                  resolution: $(elementLink).attr('id').match(/\d+p$/)[0],
                  magnetLink: $(elementLink).find('a[title="Magnet Link"]').attr('href'),
                  torrentLink: $(elementLink).find('a[title="Torrent Link"]').attr('href')
                })).get()
          })).get());
}

function _getAllLatestEntries(config, page = 0) {
  const pageParam = page === 0 ? '' : `&nextid=${page}`;
  const entriesEndpoint = `/api.php?method=getlatest${pageParam}`;
  return _getContent(entriesEndpoint, config)
      .then(($) => $('li a')
          .map((index, element) => ({
            urlEndpoint: $(element).attr('href'),
            episode: $(element).find('strong').text()
          })).get())
      .then((entries) => entries.length < 12
          ? entries
          : _getAllLatestEntries(config, page + 1)
              .then((nextEntries) => entries.concat(nextEntries)));
}

async function _findLatestEntry(entry, config) {
  const showId = await _getShowId(entry.urlEndpoint);
  let foundEntry;
  let page = 0;
  let reachedEnd = false;

  while (!foundEntry && !reachedEnd) {
    const allEntries = await _getAllEntries(showId, 'show', config, page, false);
    foundEntry = allEntries.filter((e) => e.episode === entry.episode)[0];
    page = page + 1;
    reachedEnd = allEntries.length === 0;
  }

  if (!foundEntry) {
    return;
  }
  return {
    title: foundEntry.title,
    url: entry.urlEndpoint,
    showId: showId,
    singleEpisodes: [foundEntry]
  };
}

function _parseDate(date) {
  if (date.match(/today/i)) {
    return moment().toDate();
  } else if (date.match(/yesterday/i)) {
    return moment().subtract(1, 'day').toDate();
  }
  return moment(date, 'MM/DD/YYYY').toDate();
}

module.exports = { allShows, showData, getLatestEntries, _getShowId };

