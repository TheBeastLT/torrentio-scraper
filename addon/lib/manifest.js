const { MochOptions } = require('../moch/moch');

const Providers = [
  'YTS',
  'EZTV',
  'RARBG',
  '1337x',
  'ThePirateBay',
  'KickassTorrents',
  'HorribleSubs',
  'NyaaSi',
  'NyaaPantsu'
];
const DefaultProviders = Providers

function manifest(config = {}) {
  const providersList = config.providers && config.providers.map(provider => getProvider(provider)) || DefaultProviders;
  const enabledProvidersDesc = Providers
      .map(provider => `${provider}${providersList.includes(provider) ? '(+)' : '(-)'}`)
      .join(', ')
  const enabledMochs = Object.values(MochOptions)
      .filter(moch => config[moch.key])
      .map(moch => moch.name)
      .join(' & ');
  const possibleMochs = Object.values(MochOptions).map(moch => moch.name).join('/')
  const mochsDesc = enabledMochs ? ` and ${enabledMochs} enabled ` : '';
  return {
    id: 'com.stremio.torrentio.addon',
    version: '0.0.6',
    name: 'Torrentio',
    description: 'Provides torrent streams from scraped torrent providers.'
        + ` Currently supports ${enabledProvidersDesc}${mochsDesc}.`
        + ` To configure providers, ${possibleMochs} support and other settings visit https://torrentio.strem.fun`,
    catalogs: [],
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'kitsu'],
    background: `https://i.ibb.co/VtSfFP9/t8wVwcg.jpg`,
    logo: `https://i.ibb.co/w4BnkC9/GwxAcDV.png`,
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  }
}

function getProvider(configProvider) {
  return Providers.find(provider => provider.toLowerCase() === configProvider);
}

module.exports = { manifest, Providers, DefaultProviders };