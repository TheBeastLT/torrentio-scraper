import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { MOVIES, AMBIGUOUS } from './fixtures/movies.js';

// repository.js builds a Sequelize instance on import; it never connects in these tests
process.env.DATABASE_URI ||= 'postgres://user:pass@127.0.0.1:1/test';

const GB = 1024 * 1024 * 1024;
const FLAG_REGEX = /[\u{1F1E6}-\u{1F1FF}]|\u{1F3F4}[\u{E0060}-\u{E007F}]+/u;

let toStreamInfo, stripInternalInfo, extractSeeders, extractSize, extractProvider, streamFilename, applyFilters;

before(async () => {
  ({ toStreamInfo, stripInternalInfo } = await import('../lib/streamInfo.js'));
  ({ extractSeeders, extractSize, extractProvider } = await import('../lib/titleHelper.js'));
  ({ streamFilename } = await import('../moch/mochHelper.js'));
  ({ default: applyFilters } = await import('../lib/filter.js'));
});

function record(input, index) {
  return {
    infoHash: index.toString(16).padStart(40, '0'),
    title: input,
    size: 4.37 * GB,
    torrent: {
      title: input,
      size: 4.37 * GB,
      seeders: 100 + index,
      provider: 'ThePirateBay',
      type: 'movie',
      trackers: 'udp://tracker.example:1337/announce'
    }
  };
}

function verifyMovie(movie, index) {
  const stream = toStreamInfo(record(movie.input, index));
  const releaseName = movie.input.replace(/[, ]+/g, ' ');

  // the release name stays the identifying first line, only flag emojis are removed
  const withoutFlags = releaseName.replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '').replace(/ {2,}/g, ' ').trim();
  assert.equal(stream.title.split('\n')[0], withoutFlags);
  assert.doesNotMatch(stream.title, FLAG_REGEX);

  // quality line, seeders, size and provider keep their format
  assert.equal(stream.name, `Torrentio\n${movie.quality}`);
  assert.ok(stream.title.includes(`👤 ${100 + index} 💾 4.37 GB ⚙️ ThePirateBay`));
  assert.equal(extractSeeders(stream.title), 100 + index);
  assert.equal(extractSize(stream.title), Math.floor(4.37 * GB));
  assert.equal(extractProvider(stream.title), 'ThePirateBay');

  // playback and debrid resolve urls are unaffected
  assert.deepEqual(stream.sources, ['tracker:udp://tracker.example:1337/announce', `dht:${stream.infoHash}`]);
  assert.ok(stream.behaviorHints.bingeGroup.startsWith(`torrentio|${movie.quality.split(' ')[0]}`));
  assert.equal(streamFilename(stream), encodeURIComponent(releaseName.split('/').pop()));
  assert.ok(!('releaseName' in stripInternalInfo([stream])[0]));

  // filtering keeps working; 3D streams are excluded by the 3D filter, resolution filters match plain qualities only
  const resolution = movie.quality.split(' ')[0];
  const qualityKey = movie.quality.includes('3D') ? 'threed' : resolution;
  assert.equal(applyFilters([stream], { qualityfilter: [qualityKey] }).length, 0);
  assert.equal(applyFilters([stream], { providers: ['thepiratebay'] }).length, 1);
  assert.equal(applyFilters([stream], { providers: ['yts'] }).length, 0);
  assert.equal(applyFilters([stream], { sizefilter: ['4GB'], type: 'movie' }).length, 0);
  assert.equal(applyFilters([stream], { sizefilter: ['5GB'], type: 'movie' }).length, 1);
}

describe('100 movies', () => {
  MOVIES.forEach((movie, index) => {
    it(`${index + 1}. ${movie.movie}`, () => verifyMovie(movie, index + 1));
  });
});

describe('similar titles and sequels', () => {
  AMBIGUOUS.forEach((movie, index) => {
    it(movie.movie, () => verifyMovie(movie, 200 + index));
  });

  it('keeps every release distinguishable', () => {
    const titles = [...MOVIES, ...AMBIGUOUS].map((movie, index) => toStreamInfo(record(movie.input, index)).title.split('\n')[0]);
    assert.equal(new Set(titles).size, titles.length);
  });
});
