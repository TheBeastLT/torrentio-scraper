const Providers = [
  'ThePirateBay',
  'RARBG',
  '1337x',
  'KickassTorrents',
  'HorribleSubs'
];

function manifest({ providers, realdebrid } = {}) {
  const providersList = Array.isArray(providers) && providers.map(provider => getProvider(provider)) || Providers;
  const providersDesc = providers && providers.length ? 'Enabled providers -' : 'Currently supports';
  const realDebridDesc = realdebrid ? ' and RealDebrid enabled' : '';
  return {
    id: 'com.stremio.torrentio.addon',
    version: '0.0.1-beta',
    name: 'Torrentio',
    description: '[BETA] Provides torrent streams from scraped torrent providers.'
        + ` ${providersDesc} ${providersList.join(', ')}${realDebridDesc}.`
        + ' To configure providers and and RealDebrid support visit www.torrentio.now.sh',
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

module.exports = { manifest, Providers };