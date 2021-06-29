const thepiratebayScraper = require('../scrapers/thepiratebay/thepiratebay_scraper');
const thepiratebayFakeRemoval = require('../scrapers/thepiratebay/thepiratebay_fakes_removal');
const ytsScraper = require('../scrapers/yts/yts_scraper');
const eztvScraper = require('../scrapers/eztv/eztv_scraper');
const leetxScraper = require('../scrapers/1337x/1337x_scraper');
const kickassScraper = require('../scrapers/kickass/kickass_scraper');
const rarbgScraper = require('../scrapers/rarbg/rarbg_scraper');
const nyaaPantsuScraper = require('../scrapers/nyaapantsu/nyaa_pantsu_scraper');
const nyaaSiScraper = require('../scrapers/nyaasi/nyaa_si_scraper');
const torrentGalaxyScraper = require('../scrapers/torrentgalaxy/torrentgalaxy_scraper');
const rutorScraper = require('../scrapers/rutor/rutor_scraper');

module.exports = [
  { scraper: ytsScraper, name: ytsScraper.NAME, cron: '0 0 */4 ? * *' },
  { scraper: eztvScraper, name: eztvScraper.NAME, cron: '0 0 */4 ? * *' },
  { scraper: nyaaSiScraper, name: nyaaSiScraper.NAME, cron: '0 0 */4 ? * *' },
  { scraper: nyaaPantsuScraper, name: nyaaPantsuScraper.NAME, cron: '0 0 */4 ? * *' },
  { scraper: rarbgScraper, name: rarbgScraper.NAME, cron: '0 0 */1 ? * *' },
  { scraper: rutorScraper, name: rutorScraper.NAME, cron: '0 0 */4 ? * *' },
  { scraper: thepiratebayScraper, name: thepiratebayScraper.NAME, cron: '0 0 */2 ? * *' },
  { scraper: thepiratebayFakeRemoval, name: thepiratebayFakeRemoval.NAME, cron: '0 0 */12 ? * *' },
  { scraper: torrentGalaxyScraper, name: torrentGalaxyScraper.NAME, cron: '0 0 */4 ? * *' },
  { scraper: leetxScraper, name: leetxScraper.NAME, cron: '0 0 */4 ? * *' },
  // { scraper: kickassScraper, name: kickassScraper.NAME, cron: '0 0 */4 ? * *' },
  // { scraper: require('../scrapers/rarbg/rarbg_dump_scraper') }
  // { scraper: require('../scrapers/1337x/1337x_search_scraper') }
  // { scraper: require('../scrapers/rarbg/rarbg_dump_scraper') }
  // { scraper: require('../scrapers/thepiratebay/thepiratebay_dump_scraper') }
  // { scraper: require('../scrapers/thepiratebay/thepiratebay_unofficial_dump_scraper') }
  // { scraper: require('../scrapers/thepiratebay/thepiratebay_update_size_scraper') }
];
