const { QualityFilter } = require('./filter');
const { languages, containsLanguage } = require('./languages');

const OTHER_QUALITIES = QualityFilter.options.find(option => option.key === 'other');
const CAM_QUALITIES = QualityFilter.options.find(option => option.key === 'cam');
const HEALTHY_SEEDERS = 5;
const SEEDED_SEEDERS = 1;
const MIN_HEALTHY_COUNT = 50;
const MAX_UNHEALTHY_COUNT = 5;

const SortOptions = {
  key: 'sort',
  options: {
    qualitySeeders: {
      key: 'quality',
      description: 'By quality then seeders'
    },
    qualitySize: {
      key: 'qualitysize',
      description: 'By quality then size'
    },
    seeders: {
      key: 'seeders',
      description: 'By seeders'
    },
    size: {
      key: 'size',
      description: 'By size'
    },
  }
}
const LanguageOptions = {
  key: 'language',
  options: languages.map(lang => ({
    key: lang,
    label: lang.charAt(0).toUpperCase() + lang.substr(1)
  }))
}

function sortStreams(streams, config) {
  const language = config[LanguageOptions.key];
  if (language) {
    const streamsWithLanguage = streams.filter(stream => containsLanguage(stream, language));
    const streamsNoLanguage = streams.filter(stream => !streamsWithLanguage.includes(stream));
    return _sortStreams(streamsWithLanguage, config).concat(_sortStreams(streamsNoLanguage, config));
  }
  return _sortStreams(streams, config);
}

function _sortStreams(streams, config) {
  const sort = config.sort && config.sort.toLowerCase() || undefined;
  const limit = /^[1-9][0-9]*$/.test(config.limit) && parseInt(config.limit) || undefined;
  if (sort === SortOptions.options.seeders.key) {
    return sortBySeeders(streams, limit);
  } else if (sort === SortOptions.options.size.key) {
    return sortBySize(streams, limit);
  }
  const nestedSort = sort === SortOptions.options.qualitySize.key ? sortBySize : noopSort;
  return sortByVideoQuality(streams, nestedSort, limit)
}

function noopSort(streams) {
  return streams;
}

function sortBySeeders(streams, limit) {
  // streams are already presorted by seeders and upload date
  const healthy = streams.filter(stream => extractSeeders(stream.title) >= HEALTHY_SEEDERS);
  const seeded = streams.filter(stream => extractSeeders(stream.title) >= SEEDED_SEEDERS);

  if (healthy.length >= MIN_HEALTHY_COUNT) {
    return healthy.slice(0, limit);
  } else if (seeded.length >= MAX_UNHEALTHY_COUNT) {
    return seeded.slice(0, MIN_HEALTHY_COUNT).slice(0, limit);
  }
  return streams.slice(0, MAX_UNHEALTHY_COUNT).slice(0, limit);
}

function sortBySize(streams, limit) {
  return sortBySeeders(streams)
      .sort((a, b) => {
        const aSize = extractSize(a.title);
        const bSize = extractSize(b.title);
        return bSize - aSize;
      }).slice(0, limit);
}

function sortByVideoQuality(streams, nestedSort, limit) {
  const qualityMap = sortBySeeders(streams)
      .reduce((map, stream) => {
        const quality = extractQuality(stream.name);
        map[quality] = (map[quality] || []).concat(stream);
        return map;
      }, {});
  const sortedQualities = Object.keys(qualityMap)
      .sort((a, b) => {
        const aResolution = a && a.match(/\d+p/) && parseInt(a, 10);
        const bResolution = b && b.match(/\d+p/) && parseInt(b, 10);
        if (aResolution && bResolution) {
          return bResolution - aResolution; // higher resolution first;
        } else if (aResolution) {
          return -1; // remain higher if resolution is there
        } else if (bResolution) {
          return 1; // move downward if other stream has resolution
        }
        return a < b ? -1 : b < a ? 1 : 0; // otherwise sort by alphabetic order
      });
  return sortedQualities
      .map(quality => nestedSort(qualityMap[quality]).slice(0, limit))
      .reduce((a, b) => a.concat(b), []);
}

function extractQuality(title) {
  const qualityDesc = title.split('\n')[1];
  const resolutionMatch = qualityDesc && qualityDesc.match(/\d+p/);
  if (resolutionMatch) {
    return resolutionMatch[0];
  } else if (/8k/i.test(qualityDesc)) {
    return '4320p'
  } else if (/4k|uhd/i.test(qualityDesc)) {
    return '2060p'
  } else if (CAM_QUALITIES.test(qualityDesc)) {
    return CAM_QUALITIES.label;
  } else if (OTHER_QUALITIES.test(qualityDesc)) {
    return OTHER_QUALITIES.label;
  }
  return qualityDesc;
}

function extractSeeders(title) {
  const seedersMatch = title.match(/👤 (\d+)/);
  return seedersMatch && parseInt(seedersMatch[1]) || 0;
}

function extractSize(title) {
  const seedersMatch = title.match(/💾 ([\d.]+ \w+)/);
  return seedersMatch && parseSize(seedersMatch[1]) || 0;
}

function parseSize(sizeText) {
  if (!sizeText) {
    return 0;
  }
  let scale = 1;
  if (sizeText.includes('TB')) {
    scale = 1024 * 1024 * 1024 * 1024
  } else if (sizeText.includes('GB')) {
    scale = 1024 * 1024 * 1024
  } else if (sizeText.includes('MB')) {
    scale = 1024 * 1024;
  } else if (sizeText.includes('kB')) {
    scale = 1024;
  }
  return Math.floor(parseFloat(sizeText.replace(/,/g, '')) * scale);
}

module.exports = sortStreams;
module.exports.SortOptions = SortOptions;
module.exports.LanguageOptions = LanguageOptions;