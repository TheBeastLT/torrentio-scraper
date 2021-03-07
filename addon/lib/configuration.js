const { DebridOptions } = require('../moch/options');
const { QualityFilter } = require('./filter');

const keysToSplit = ['providers', QualityFilter.key, DebridOptions.key];

function parseConfiguration(configuration) {
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

module.exports = parseConfiguration;