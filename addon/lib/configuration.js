const { DebridOptions } = require('../moch/options');
const { QualityFilter, Providers } = require('./filter');

const LITE_CONFIG = liteConfig();
const LITE_CONFIG_VALUE = liteConfigValue();

const keysToSplit = [Providers.key, QualityFilter.key, DebridOptions.key];

function parseConfiguration(configuration) {
  if (configuration === 'lite') {
    return LITE_CONFIG;
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
      .filter(key => configValues[key] = configValues[key].split(',').map(provider => provider.toLowerCase()))
  return configValues;
}

function liteConfig() {
  const config = {};
  config[Providers.key] = Providers.options.filter(provider => !provider.foreign).map(provider => provider.key);
  config[QualityFilter.key] = ['scr', 'cam']
  config['limit'] = 1;
  config['lite'] = true;
  return config;
}

function liteConfigValue() {
  return Object.entries(LITE_CONFIG)
      .filter(([key]) => key !== 'lite')
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`)
      .join('|');
}

module.exports = parseConfiguration;
module.exports.LiteConfigValue = LITE_CONFIG_VALUE;