const thepiratebayScraper = require('../scrapers/thepiratebay/thepiratebay_scraper');
const horribleSubsScraper = require('../scrapers/horriblesubs/horriblesubs_scraper');
const ytsScraper = require('../scrapers/yts/yts_scraper');
const eztvScraper = require('../scrapers/eztv/eztv_scraper');
const leetxScraper = require('../scrapers/1337x/1337x_scraper');
const kickassScraper = require('../scrapers/kickass/kickass_scraper');
const rarbgScraper = require('../scrapers/rarbg/rarbg_scraper');

module.exports = [
  { scraper: ytsScraper, name: ytsScraper.NAME, scrapeInterval: 4 * 60 * 60 * 1000 },
  { scraper: eztvScraper, name: eztvScraper.NAME, scrapeInterval: 4 * 60 * 60 * 1000 },
  { scraper: horribleSubsScraper, name: horribleSubsScraper.NAME, scrapeInterval: 4 * 60 * 60 * 1000 },
  { scraper: rarbgScraper, name: rarbgScraper.NAME, scrapeInterval: 2 * 60 * 60 * 1000 },
  { scraper: thepiratebayScraper, name: thepiratebayScraper.NAME, scrapeInterval: 4 * 60 * 60 * 1000 },
  { scraper: kickassScraper, name: kickassScraper.NAME, scrapeInterval: 4 * 60 * 60 * 1000 },
  { scraper: leetxScraper, name: leetxScraper.NAME, scrapeInterval: 4 * 60 * 60 * 1000 },
  // { scraper: require('../scrapers/1337x/1337x_dump_scraper') }
  // { scraper: require('../scrapers/rarbg/rarbg_dump_scraper') }
  // { scraper: require('../scrapers/thepiratebay/thepiratebay_dump_scraper') }
  // { scraper: require('../scrapers/thepiratebay/thepiratebay_unofficial_dump_scraper') }
  // { scraper: require('../scrapers/thepiratebay/thepiratebay_update_size_scraper') }
];