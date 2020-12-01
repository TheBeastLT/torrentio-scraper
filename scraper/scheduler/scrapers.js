const thepiratebayScraper = require('../scrapers/thepiratebay/thepiratebay_scraper');
const horribleSubsScraper = require('../scrapers/horriblesubs/horriblesubs_scraper');
const ytsScraper = require('../scrapers/yts/yts_scraper');
const eztvScraper = require('../scrapers/eztv/eztv_scraper');
const leetxScraper = require('../scrapers/1337x/1337x_scraper');
const kickassScraper = require('../scrapers/kickass/kickass_scraper');
const rarbgScraper = require('../scrapers/rarbg/rarbg_scraper');
const nyaaPantsuScraper = require('../scrapers/nyaapantsu/nyaa_pantsu_scraper');
const nyaaSiScraper = require('../scrapers/nyaasi/nyaa_si_scraper');

module.exports = [
  { scraper: ytsScraper, name: ytsScraper.NAME, cron: '0 0 */4 ? * *' },
  { scraper: eztvScraper, name: eztvScraper.NAME, cron: '0 0 */4 ? * *' },
  { scraper: horribleSubsScraper, name: horribleSubsScraper.NAME, cron: '0 0 */4 ? * *' },
  { scraper: nyaaSiScraper, name: nyaaSiScraper.NAME, cron: '0 0 */4 ? * *' },
  { scraper: nyaaPantsuScraper, name: nyaaPantsuScraper.NAME, cron: '0 0 */4 ? * *' },
  { scraper: rarbgScraper, name: rarbgScraper.NAME, cron: '0 0 */2 ? * *' },
  { scraper: thepiratebayScraper, name: thepiratebayScraper.NAME, cron: '0 0 */2 ? * *' },
  { scraper: leetxScraper, name: leetxScraper.NAME, cron: '0 0 */4 ? * *' },
  { scraper: kickassScraper, name: kickassScraper.NAME, cron: '0 0 */4 ? * *' },
  // { scraper: require('../scrapers/rarbg/rarbg_dump_scraper') }
  // { scraper: require('../scrapers/1337x/1337x_search_scraper') }
  // { scraper: require('../scrapers/rarbg/rarbg_dump_scraper') }
  // { scraper: require('../scrapers/thepiratebay/thepiratebay_dump_scraper') }
  // { scraper: require('../scrapers/thepiratebay/thepiratebay_unofficial_dump_scraper') }
  // { scraper: require('../scrapers/thepiratebay/thepiratebay_update_size_scraper') }
];