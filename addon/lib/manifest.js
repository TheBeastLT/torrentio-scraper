const Providers = [
  'YTS',
  'EZTV',
  'RARBG',
  '1337x',
  'ThePirateBay',
  'KickassTorrents',
  'HorribleSubs'
];
const DefaultProviders = Providers

function manifest({ providers, realdebrid } = {}) {
  const providersList = providers && providers.map(provider => getProvider(provider)) || DefaultProviders;
  const enabledProvidersDesc = Providers
      .map(provider => `${provider}${providersList.includes(provider) ? '(+)' : '(-)'}`)
      .join(', ')
  const realDebridDesc = realdebrid ? ' and RealDebrid enabled' : '';
  return {
    id: 'com.stremio.torrentio.addon',
    version: '0.0.4',
    name: 'Torrentio',
    description: 'Provides torrent streams from scraped torrent providers.'
        + ` Currently supports ${enabledProvidersDesc}${realDebridDesc}.`
        + ' To configure providers, RealDebrid support and other settings visit https://torrentio.strem.fun',
    catalogs: [],
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'kitsu'],
    background: `https://i.ibb.co/VtSfFP9/t8wVwcg.jpg`,
    logo: `https://i.ibb.co/w4BnkC9/GwxAcDV.png`,
  }
}

function getProvider(configProvider) {
  return Providers.find(provider => provider.toLowerCase() === configProvider);
}

module.exports = { manifest, Providers, DefaultProviders };