const scrapers = require('./scrapers');
const { delay, sequence } = require('../lib/promises')

function scheduleScraping() {
  return scrapers.forEach(provider => _continuousScrape(provider))
}

function scrapeAll() {
  return sequence(scrapers.map(provider => () => _singleScrape(provider)))
}

async function _continuousScrape(provider) {
  return _singleScrape(provider)
      .then(() => delay(provider.scrapeInterval))
      .then(() => _continuousScrape(provider))
}

async function _singleScrape(provider) {
  return provider.scraper.scrape().catch(error => {
    console.warn(`Failed ${provider.name} scraping due: `, error);
    return Promise.resolve()
  })
}

module.exports = { scheduleScraping, scrapeAll }