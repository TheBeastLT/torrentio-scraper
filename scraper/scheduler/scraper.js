const schedule = require('node-schedule');
const scrapers = require('./scrapers');
const { sequence } = require('../lib/promises')

function scheduleScraping() {
  const allCrons = scrapers.reduce((crons, provider) => {
    crons[provider.cron] = (crons[provider.cron] || []).concat(provider)
    return crons;
  }, {});
  Object.entries(allCrons).forEach(([cron, providers]) => schedule.scheduleJob(cron, () => _scrapeProviders(providers)))
}

function scrapeAll() {
  return _scrapeProviders(scrapers)
}

async function _scrapeProviders(providers) {
  return sequence(providers.map(provider => () => _singleScrape(provider)));
}

async function _singleScrape(provider) {
  return provider.scraper.scrape().catch(error => {
    console.warn(`Failed ${provider.name} scraping due: `, error);
    return Promise.resolve()
  })
}

module.exports = { scheduleScraping, scrapeAll }