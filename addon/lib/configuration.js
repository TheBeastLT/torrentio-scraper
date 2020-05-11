function parseConfiguration(configuration) {
  const configValues = configuration.split('|')
      .reduce((map, next) => {
        const parameterParts = next.split('=');
        if (parameterParts.length === 2) {
          map[parameterParts[0].toLowerCase()] = parameterParts[1];
        }
        return map;
      }, {});
  if (configValues.providers) {
    configValues.providers = configValues.providers.split(',').map(provider => provider.toLowerCase());
  }
  if (configValues.debridoptions) {
    configValues.debridoptions = configValues.debridoptions.split(',').map(option => option.toLowerCase());
  }
  return configValues;
}

module.exports = parseConfiguration;