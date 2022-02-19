const Parser = require('rss-parser');
const decode = require("magnet-uri");

const parser = new Parser({
  customFields: {
    item: [['erai:subtitles', 'subtitles']]
  }
});
const baseUrl = 'https://www.erai-raws.info';
const rssKey = process.env.ERAI_RSS_KEY;

const Categories = {
  ANIMES: 'anime',
  EPISODES: 'episodes'
};

function browse() {
  return parser.parseURL(`${baseUrl}/feed/?type=magnet&${rssKey}`)
      .then(result => result.items
          .map(item => {
            const decodedMagnet = decode(item.link);
            const languages = parseLanguages(item.subtitles);
            return {
              title: decodedMagnet.name,
              infoHash: decodedMagnet.infoHash,
              trackers: decodedMagnet.tr,
              languages: languages
            }
          }));
}

const languageMapping = {
  'us': 'English',
  'br': 'Portuguese(Brazil)',
  'mx': 'Spanish(Latin_America)',
  'es': 'Spanish',
  'sa': 'Arabic',
  'fr': 'French',
  'de': 'German',
  'it': 'Italian',
  'ru': 'Russian'
}
function parseLanguages(languages) {
    return languages.split('][')
        .map(lang => lang.replace(/[\[\]]/g, ''))
        .map(lang => languageMapping[lang] || lang)
        .join('/');
}

module.exports = { browse, Categories };
