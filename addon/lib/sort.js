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
  const sortedStreams = streams
      .sort((a, b) => b.filters.seeders - a.filters.seeders || b.filters.uploadDate - a.filters.uploadDate);
  const healthy = sortedStreams.filter(stream => stream.filters.seeders >= HEALTHY_SEEDERS);
  const seeded = sortedStreams.filter(stream => stream.filters.seeders >= SEEDED_SEEDERS);

  if (healthy.length >= MIN_HEALTHY_COUNT) {
    return healthy;
  } else if (seeded.length >= MAX_UNHEALTHY_COUNT) {
    return seeded.slice(0, MIN_HEALTHY_COUNT);
  }
  return sortedStreams.slice(0, MAX_UNHEALTHY_COUNT);
}

function sortByVideoQuality(streams, limit) {
  const qualityMap = sortBySeeders(streams)
      .reduce((map, stream) => {
        const quality = stream.filters.quality;
        map[quality] = (map[quality] || []).concat(stream);
        return map;
      }, {});
  const sortedQualities = Object.keys(qualityMap)
      .sort((a, b) => {
        const aQuality = a === '4k' ? '2160p' : a;
        const bQuality = b === '4k' ? '2160p' : b;
        const aResolution = aQuality && aQuality.match(/\d+p/) && parseInt(aQuality, 10);
        const bResolution = bQuality && bQuality.match(/\d+p/) && parseInt(bQuality, 10);
        if (aResolution && bResolution) {
          return bResolution - aResolution; // higher resolution first;
        } else if (aResolution) {
          return -1;
        } else if (bResolution) {
          return 1;
        }
        return a < b ? -1 : b < a ? 1 : 0;
      });
  return sortedQualities
      .map(quality => qualityMap[quality].slice(0, limit))
      .reduce((a, b) => a.concat(b), []);
}

module.exports = sortStreams;
module.exports.SortType = SortType;