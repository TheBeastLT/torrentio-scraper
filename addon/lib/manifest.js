const { MochOptions } = require('../moch/moch');
const { Type } = require('./types');

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
const CatalogMochs = [MochOptions.realdebrid, MochOptions.alldebrid];

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
    version: '0.0.7',
    name: 'Torrentio',
    description: 'Provides torrent streams from scraped torrent providers.'
        + ` Currently supports ${enabledProvidersDesc}${mochsDesc}.`
        + ` To configure providers, ${possibleMochs} support and other settings visit https://torrentio.strem.fun`,
    catalogs: getCatalogs(config),
    resources: getResources(config),
    types: [Type.MOVIE, Type.SERIES, Type.OTHER],
    background: `https://i.ibb.co/VtSfFP9/t8wVwcg.jpg`,
    logo: `https://i.ibb.co/w4BnkC9/GwxAcDV.png`,
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  }
}

function dummyManifest() {
  const manifestDefault = manifest();
  manifestDefault.catalogs = [{ id: 'dummy', type: Type.OTHER }];
  manifestDefault.resources = ['stream', 'meta'];
  return manifestDefault;
}

function getProvider(configProvider) {
  return Providers.find(provider => provider.toLowerCase() === configProvider);
}

function getCatalogs(config) {
  return CatalogMochs
      .filter(moch => config[moch.key])
      .map(moch => ({
        id: `torrentio-${moch.key}`,
        name: `${moch.name}`,
        type: 'other',
      }));
}

function getResources(config) {
  const streamResource = {
    name: 'stream',
    types: [Type.MOVIE, Type.SERIES],
    idPrefixes: ['tt', 'kitsu']
  };
  const metaResource = {
    name: 'meta',
    types: [Type.OTHER],
    idPrefixes: CatalogMochs.filter(moch => config[moch.key]).map(moch => moch.key)
  };
  if (CatalogMochs.filter(moch => config[moch.key]).length) {
    return [streamResource, metaResource];
  }
  return [streamResource];
}

module.exports = { manifest, dummyManifest, Providers, DefaultProviders };