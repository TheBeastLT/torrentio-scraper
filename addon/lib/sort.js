import { QualityFilter } from './filter.js';
import { containsLanguage, LanguageOptions } from './languages.js';
import { Type } from './types.js';
import { hasMochConfigured } from '../moch/moch.js';
import { extractSeeders, extractSize } from './titleHelper.js';

const OTHER_QUALITIES = QualityFilter.options.find(option => option.key === 'other');
const CAM_QUALITIES = QualityFilter.options.find(option => option.key === 'cam');
const HEALTHY_SEEDERS = 5;
const SEEDED_SEEDERS = 1;
const MIN_HEALTHY_COUNT = 50;
const MAX_UNHEALTHY_COUNT = 5;

// Putting these here for future use... Ideally will give the user
// the ability to define a custom sort, but needs a front-end first
const WEIGHTS = {
  seeders: 1,
  size: 1,
  quality: 1,
  language: 10,
}; 

export const SortOptions = {
  key: 'sort',
  options: {
    points: {
      key: 'points',
      description: 'Smart (seeders * quality/size)',
    },
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

export default function sortStreams(streams, config, type) {
  const languages = config[LanguageOptions.key];
  if (languages?.length && languages[0] !== 'english') {
    // No need to filter english since it's hard to predict which entries are english
    const streamsWithLanguage = streams.filter(stream => containsLanguage(stream, languages));
    const streamsNoLanguage = streams.filter(stream => !streamsWithLanguage.includes(stream));
    return _sortStreams(streamsWithLanguage, config, type).concat(_sortStreams(streamsNoLanguage, config, type));
  }
  return _sortStreams(streams, config, type);
}

function _sortStreams(streams, config, type) {
  const sort = config?.sort?.toLowerCase() || undefined;
  const limit = /^[1-9][0-9]*$/.test(config.limit) && parseInt(config.limit) || undefined;
  const sortedStreams = sortBySeeders(streams, config, type);
  if (sort === SortOptions.options.seeders.key) {
    return sortedStreams.slice(0, limit);
  } else if (sort === SortOptions.options.size.key) {
    return sortBySize(sortedStreams, limit);
  } else if (sort === SortOptions.options.points.key) {
    return sortByPoints(sortedStreams, limit);
  }
  const nestedSort = sort === SortOptions.options.qualitySize.key ? sortBySize : noopSort;
  return sortByVideoQuality(sortedStreams, nestedSort, limit)
}

function sortByPoints(streams, limit) {
  return streams
    .map(stream => {
      const seedersScore = extractSeeders(stream.title) * WEIGHTS.seeders;
      const sizeScore = extractSize(stream.title) * WEIGHTS.size;
      const qualityScore = getQualityScore(stream) * WEIGHTS.quality;
      const totalScore = seedersScore * (qualityScore/sizeScore); // seeders * (quality/size)
      return { ...stream, totalScore };
    })
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, limit);
}

function getQualityScore(stream) {
  const quality = extractQuality(stream.name);
  if (/8k/i.test(quality)) return 5; // highest score for 8k
  if (/4k|uhd/i.test(quality)) return 4;
  if (quality.match(/\d+p/)) return parseInt(quality, 10) / 1000; // scale resolution to score
  if (CAM_QUALITIES.test(quality)) return 0.1; // low score for cam quality
  if (OTHER_QUALITIES.test(quality)) return 0.2;
  return 1; // fallback score
}

function noopSort(streams) {
  return streams;
}

function sortBySeeders(streams, config, type) {
  // streams are already presorted by seeders and upload date
  const healthy = streams.filter(stream => extractSeeders(stream.title) >= HEALTHY_SEEDERS);
  const seeded = streams.filter(stream => extractSeeders(stream.title) >= SEEDED_SEEDERS);

  if (type === Type.SERIES && hasMochConfigured(config)) {
    return streams;
  } else if (healthy.length >= MIN_HEALTHY_COUNT) {
    return healthy;
  } else if (seeded.length >= MAX_UNHEALTHY_COUNT) {
    return seeded.slice(0, MIN_HEALTHY_COUNT);
  }
  return streams.slice(0, MAX_UNHEALTHY_COUNT);
}

function sortBySize(streams, limit) {
  return streams
    .sort((a, b) => {
      const aSize = extractSize(a.title);
      const bSize = extractSize(b.title);
      return bSize - aSize;
      }).slice(0, limit);
}

function sortByVideoQuality(streams, nestedSort, limit) {
  const qualityMap = streams
      .reduce((map, stream) => {
    const quality = extractQuality(stream.name);
    map[quality] = (map[quality] || []).concat(stream);
    return map;
  }, {});
  const sortedQualities = Object.keys(qualityMap)
      .sort((a, b) => {
    const aResolution = a?.match(/\d+p/) && parseInt(a, 10);
    const bResolution = b?.match(/\d+p/) && parseInt(b, 10);
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
  const resolutionMatch = qualityDesc?.match(/\d+p/);
  const isHDR = qualityDesc?.match(/HDR|DV/);
  const withHDRScore = resolution => isHDR ? resolution.replace('0p', '1p') : resolution;
  if (resolutionMatch) {
    return withHDRScore(resolutionMatch[0]);
  } else if (/8k/i.test(qualityDesc)) {
    return withHDRScore('4320p');
  } else if (/4k|uhd/i.test(qualityDesc)) {
    return withHDRScore('2060p');
  } else if (CAM_QUALITIES.test(qualityDesc)) {
    return CAM_QUALITIES.label;
  } else if (OTHER_QUALITIES.test(qualityDesc)) {
    return OTHER_QUALITIES.label;
  }
  return qualityDesc;
}
