import { QualityFilter } from './filter.js';
import { containsLanguage, LanguageOptions } from './languages.js';
import { hasMochConfigured } from '../moch/moch.js';
import { extractSeeders, extractSize } from './titleHelper.js';

const OTHER_QUALITIES = QualityFilter.options.find(option => option.key === 'other');
const CAM_QUALITIES = QualityFilter.options.find(option => option.key === 'cam');
const HEALTHY_SEEDERS = 5;
const SEEDED_SEEDERS = 1;
const MIN_HEALTHY_COUNT = 50;
const MAX_UNHEALTHY_COUNT = 5;

export const SortOptions = {
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

export default function sortStreams(streams, config, type) {
  const languages = config[LanguageOptions.key];
  if (languages?.length && languages[0] !== 'english') {
    // No need to filter english since it's hard to predict which entries are english
    const streamsWithLanguage = streams.filter(stream => containsLanguage(stream, languages));
    const withLanguage = new Set(streamsWithLanguage);
    const streamsNoLanguage = streams.filter(stream => !withLanguage.has(stream));
    return _sortStreams(streamsWithLanguage, config, type).concat(_sortStreams(streamsNoLanguage, config, type));
  }
  return _sortStreams(streams, config, type);
}

function _sortStreams(streams, config, type) {
  const sort = config?.sort?.toLowerCase() || undefined;
  const limit = /^[1-9][0-9]*$/.test(config.limit) && parseInt(config.limit) || undefined;
  const fastestFirst = selectHealthyStreams(streams, config);
  if (!sort || sort === SortOptions.options.seeders.key) {
    // default: catalogue by fastest seed (most seeders first)
    return fastestFirst.slice(0, limit);
  } else if (sort === SortOptions.options.size.key) {
    return sortBySize(fastestFirst, limit);
  }
  const nestedSort = sort === SortOptions.options.qualitySize.key ? sortBySize : noopSort;
  return sortByVideoQuality(fastestFirst, nestedSort, limit)
}

function noopSort(streams) {
  return streams;
}

// Ranks by seeders (most = fastest) and trims to a healthy swarm size.
// Debrid/moch providers fetch server-side, so local peer health is
// irrelevant to download speed there and the raw list is left untouched.
function selectHealthyStreams(streams, config) {
  if (hasMochConfigured(config)) {
    return streams;
  }

  const bySeeders = streams
      .map(stream => ({ stream, seeders: extractSeeders(stream.title) }))
      .sort((a, b) => b.seeders - a.seeders);

  const healthy = bySeeders.filter(entry => entry.seeders >= HEALTHY_SEEDERS);
  const seeded = bySeeders.filter(entry => entry.seeders >= SEEDED_SEEDERS);

  const ranked = healthy.length >= MIN_HEALTHY_COUNT ? healthy
      : seeded.length >= MAX_UNHEALTHY_COUNT ? seeded.slice(0, MIN_HEALTHY_COUNT)
      : bySeeders.slice(0, MAX_UNHEALTHY_COUNT);

  return ranked.map(entry => entry.stream);
}

function sortBySize(streams, limit) {
  return streams
      .map(stream => ({ stream, size: extractSize(stream.title) }))
      .sort((a, b) => b.size - a.size)
      .map(entry => entry.stream)
      .slice(0, limit);
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
