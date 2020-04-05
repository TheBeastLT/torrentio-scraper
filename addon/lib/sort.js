const HEALTHY_SEEDERS = 5;
const SEEDED_SEEDERS = 1;
const MIN_HEALTHY_COUNT = 10;
const MAX_UNHEALTHY_COUNT = 5;

const SortType = {
  QUALITY: 'quality',
  SEEDERS: 'seeders',
};

function sortStreams(streams, config) {
  const sort = config.sort && config.sort.toLowerCase() || undefined;
  const limit = /^[1-9][0-9]*$/.test(config.limit) && parseInt(config.limit) || undefined;
  if (sort === SortType.SEEDERS) {
    return sortBySeeders(streams).slice(0, limit)
  }
  return sortByVideoQuality(streams, limit)
}

function sortBySeeders(streams) {
  // streams are already presorted by seeders and upload date
  const healthy = streams.filter(stream => extractSeeders(stream.title) >= HEALTHY_SEEDERS);
  const seeded = streams.filter(stream => extractSeeders(stream.title) >= SEEDED_SEEDERS);

  if (healthy.length >= MIN_HEALTHY_COUNT) {
    return healthy;
  } else if (seeded.length >= MAX_UNHEALTHY_COUNT) {
    return seeded.slice(0, MIN_HEALTHY_COUNT);
  }
  return streams.slice(0, MAX_UNHEALTHY_COUNT);
}

function sortByVideoQuality(streams, limit) {
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
      .map(quality => qualityMap[quality].slice(0, limit))
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
  }
  return qualityDesc;
}

function extractSeeders(title) {
  const seedersMatch = title.match(/👤 (\d+)/);
  return seedersMatch && parseInt(seedersMatch[1]) || 0;
}

module.exports = sortStreams;
module.exports.SortType = SortType;