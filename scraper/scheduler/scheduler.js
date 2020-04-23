const { scheduleScraping, scrapeAll } = require('./scraper')
const { scheduleUpdateSeeders } = require('./seeders')

function startScraper() {
  if (process.env.ENABLE_SCHEDULING) {
    scheduleScraping();
    scheduleUpdateSeeders();
  } else {
    scrapeAll()
  }
}

module.exports = { startScraper }