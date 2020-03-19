const realdebrid = require('./realdebrid');

const MOCHS = {
  'realdebrid': realdebrid
};

async function applyMochs(streams, config) {
  if (!streams || !streams.length) {
    return streams;
  }

  return Object.keys(config)
      .filter(configKey => MOCHS[configKey])
      .reduce(async (streams, moch) => {
        return await MOCHS[moch].applyMoch(streams, config[moch])
            .catch(error => {
              console.warn(error);
              return streams;
            });
      }, streams);
}

module.exports = applyMochs;