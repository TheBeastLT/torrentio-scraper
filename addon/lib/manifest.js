import { MochOptions } from '../moch/moch.js';
import { Providers } from './filter.js';
import { showDebridCatalog } from '../moch/options.js';
import { getManifestOverride } from './configuration.js';
import { Type } from './types.js';

const DefaultProviders = Providers.options.map(provider => provider.key);
const CatalogMochs = Object.values(MochOptions).filter(moch => moch.catalog);

export function manifest(config = {}) {
  const defaultManifest = {
    id: 'com.stremio.torrentio.addon',
    version: '0.0.13',
    name: 'Torrentio',
    description: getDescription(config),
    catalogs: getCatalogs(config),
    resources: getResources(config),
    types: [Type.MOVIE, Type.SERIES, Type.ANIME, Type.OTHER],
    background: `https://i.ibb.co/VtSfFP9/t8wVwcg.jpg`,
    logo: `https://i.ibb.co/w4BnkC9/GwxAcDV.png`,
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  }
  const overrideManifest = getManifestOverride(config);
  return Object.assign(defaultManifest, overrideManifest);
}

export function dummyManifest() {
  const manifestDefault = manifest();
  manifestDefault.catalogs = [{ id: 'dummy', type: Type.OTHER }];
  manifestDefault.resources = ['stream', 'meta'];
  return manifestDefault;
}

function getDescription(config) {
  const providersList = config[Providers.key] || DefaultProviders;
  const enabledProvidersDesc = Providers.options
      .map(provider => `${provider.label}${providersList.includes(provider.key) ? '(+)' : '(-)'}`)
      .join(', ')
  const enabledMochs = Object.values(MochOptions)
      .filter(moch => config[moch.key])
      .map(moch => moch.name)
      .join(' & ');
  const possibleMochs = Object.values(MochOptions).map(moch => moch.name).join('/')
  const mochsDesc = enabledMochs ? ` and ${enabledMochs} enabled` : '';
  return 'Provides torrent streams from scraped torrent providers.'
      + ` Currently supports ${enabledProvidersDesc}${mochsDesc}.`
      + ` To configure providers, ${possibleMochs} support and other settings visit https://torrentio.strem.fun`
}

function getCatalogs(config) {
  return CatalogMochs
      .filter(moch => showDebridCatalog(config) && config[moch.key])
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
  if (showDebridCatalog(config) && CatalogMochs.filter(moch => config[moch.key]).length) {
    return [streamResource, metaResource];
  }
  return [streamResource];
}
