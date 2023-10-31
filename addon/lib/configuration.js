import { DebridOptions } from '../moch/options.js';
import { QualityFilter, Providers, SizeFilter } from './filter.js';
import { LanguageOptions } from './languages.js';

export const PreConfigurations = {
  lite: {
    config: liteConfig(),
    serialized: configValue(liteConfig()),
    manifest: {
      id: 'com.stremio.torrentio.lite.addon',
      name: 'Torrentio Lite',
      description: 'Preconfigured Lite version of Torrentio addon.'
          + ' To configure advanced options visit https://torrentio.strem.fun/lite'
    }
  },
  brazuca: {
    config: brazucaConfig(),
    serialized: configValue(brazucaConfig()),
    manifest: {
      id: 'com.stremio.torrentio.brazuca.addon',
      name: 'Torrentio Brazuca',
      description: 'Preconfigured version of Torrentio addon for Brazilian content.'
          + ' To configure advanced options visit https://torrentio.strem.fun/brazuca',
      logo: 'https://i.ibb.co/8mgRZPp/GwxAcDV.png'
    }
  }
}

const keysToSplit = [Providers.key, LanguageOptions.key, QualityFilter.key, SizeFilter.key, DebridOptions.key];
const keysToUppercase = [SizeFilter.key];

export function parseConfiguration(configuration) {
  if (PreConfigurations[configuration]) {
    return PreConfigurations[configuration].config;
  }
  const configValues = configuration.split('|')
      .reduce((map, next) => {
        const parameterParts = next.split('=');
        if (parameterParts.length === 2) {
          map[parameterParts[0].toLowerCase()] = parameterParts[1];
        }
        return map;
      }, {});
  keysToSplit
      .filter(key => configValues[key])
      .forEach(key => configValues[key] = configValues[key].split(',')
          .map(value => keysToUppercase.includes(key) ? value.toUpperCase() : value.toLowerCase()))
  return configValues;
}

function liteConfig() {
  const config = {};
  config[Providers.key] = Providers.options
      .filter(provider => !provider.foreign)
      .map(provider => provider.key);
  config[QualityFilter.key] = ['scr', 'cam']
  config['limit'] = 1;
  return config;
}

function brazucaConfig() {
  const config = {};
  config[Providers.key] = Providers.options
      .filter(provider => !provider.foreign || provider.foreign === '🇵🇹')
      .map(provider => provider.key);
  config[LanguageOptions.key] = ['portuguese'];
  return config;
}

function configValue(config) {
  return Object.entries(config)
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`)
      .join('|');
}

export function getManifestOverride(config) {
  const preConfig = Object.values(PreConfigurations).find(pre => pre.config === config);
  return preConfig ? preConfig.manifest : {};
}