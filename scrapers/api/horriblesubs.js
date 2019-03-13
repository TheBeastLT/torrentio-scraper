const cheerio = require('cheerio');
const needle = require('needle');
const moment = require('moment');

const defaultUrl = 'https://horriblesubs.info';
const defaultTimeout = 5000;

function _getContent(url, config = {},) {
  const baseUrl = config.proxyUrl || defaultUrl;
  const timeout = config.timeout || defaultTimeout;

  return needle('get', `${baseUrl}${url}`, { open_timeout: timeout, follow: 2 })
      .then((response) => response.body)
      .then((body) => cheerio.load(body))
}

function _getAnimeId(showInfo) {
  return _getContent(showInfo.url).then($ => {
    const text = $('div.entry-content').find('script').html();
    showInfo.id = text.match(/var hs_showid = (\d+)/)[1];
    return showInfo
  })
}

function allShows(config = {}) {
  return _getContent('/shows', config)
      .then(($) =>  $('div[class=\'ind-show\']')
          .map((index, element) => $(element).children('a'))
          .map((index, element) => ({
            title: element.attr('title'),
            url: `${config.proxyUrl || defaultUrl}${element.attr('href')}`
          })).get());
}

function showData(showInfo) {
  return _getAnimeId(showInfo)
      .then((showInfo) => )

}

module.exports = { allShows };

