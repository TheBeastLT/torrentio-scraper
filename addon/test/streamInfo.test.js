import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// repository.js builds a Sequelize instance on import; it never connects in these tests
process.env.DATABASE_URI ||= 'postgres://user:pass@127.0.0.1:1/test';

let toStreamInfo, stripInternalInfo, extractSeeders, extractSize, extractProvider, stripFlags,
    containsLanguage, streamFilename, applyFilters, sortStreams;

before(async () => {
  ({ toStreamInfo, stripInternalInfo } = await import('../lib/streamInfo.js'));
  ({ extractSeeders, extractSize, extractProvider, stripFlags } = await import('../lib/titleHelper.js'));
  ({ containsLanguage } = await import('../lib/languages.js'));
  ({ streamFilename } = await import('../moch/mochHelper.js'));
  ({ default: applyFilters } = await import('../lib/filter.js'));
  ({ default: sortStreams } = await import('../lib/sort.js'));
});

const FLAG_REGEX = /[\u{1F1E6}-\u{1F1FF}]/u;
const GB = 1024 * 1024 * 1024;

function movieRecord(title, overrides = {}) {
  return {
    infoHash: 'a'.repeat(40),
    title,
    size: 2 * GB,
    ...overrides,
    torrent: {
      title,
      size: 2 * GB,
      seeders: 15,
      provider: 'ThePirateBay',
      type: 'movie',
      trackers: 'udp://tracker.example:1337/announce',
      ...overrides.torrent
    }
  };
}

function seriesRecord(overrides = {}) {
  return {
    infoHash: 'b'.repeat(40),
    fileIndex: 2,
    title: 'Breaking Bad Season 2/Breaking.Bad.S02E03.Bit.by.a.Dead.Bee.1080p.WEB-DL.DD5.1.H.264-NTb.mkv',
    size: 2 * GB,
    imdbSeason: 2,
    imdbEpisode: 3,
    ...overrides,
    torrent: {
      title: 'Breaking Bad Season 2 Complete 1080p WEB-DL DD5.1 H.264-NTb',
      size: 30 * GB,
      seeders: 42,
      provider: 'RARBG',
      type: 'series',
      ...overrides.torrent
    }
  };
}

describe('toStreamInfo description', () => {
  it('keeps the release name and stats lines', () => {
    const stream = toStreamInfo(movieRecord('Apollo.13.1995.iNTERNAL.AC3.DVDRip.XviD-SHiTHEADS'));
    assert.equal(stream.name, 'Torrentio\nDVDRip');
    assert.equal(stream.title, 'Apollo.13.1995.iNTERNAL.AC3.DVDRip.XviD-SHiTHEADS\n👤 15 💾 2 GB ⚙️ ThePirateBay');
  });

  it('removes flag emojis from release names', () => {
    const stream = toStreamInfo(movieRecord('🇧🇷 Tropa de Elite 2007 1080p 🏴󠁧󠁢󠁥󠁮󠁧󠁿 Nacional'));
    assert.equal(stream.title.split('\n')[0], 'Tropa de Elite 2007 1080p Nacional');
    assert.doesNotMatch(stream.title, FLAG_REGEX);
  });

  it('prefixes the file of season packs with its episode', () => {
    const stream = toStreamInfo(seriesRecord());
    assert.equal(stream.title, 'Breaking Bad Season 2 Complete 1080p WEB-DL DD5.1 H.264-NTb\n'
        + 'S02E03 · Breaking Bad Season 2/Breaking.Bad.S02E03.Bit.by.a.Dead.Bee.1080p.WEB-DL.DD5.1.H.264-NTb.mkv\n'
        + '👤 42 💾 2 GB ⚙️ RARBG');
  });

  it('shows the episode when the file path contains the torrent title', () => {
    const stream = toStreamInfo(seriesRecord({
      title: 'Breaking Bad Season 2 Complete 1080p WEB-DL DD5.1 H.264-NTb/Breaking.Bad.S02E03.mkv'
    }));
    assert.equal(stream.title.split('\n')[1], 'S02E03');
  });

  it('uses kitsu episodes for anime batches', () => {
    const stream = toStreamInfo(seriesRecord({
      kitsuId: 7442,
      kitsuEpisode: 3,
      imdbSeason: undefined,
      imdbEpisode: undefined,
      title: '[SubsPlease] Shingeki no Kyojin (01-25) (1080p) [Batch]/[SubsPlease] Shingeki no Kyojin - 03 (1080p).mkv',
      torrent: { title: '[SubsPlease] Shingeki no Kyojin (01-25) (1080p) [Batch]', type: 'anime', provider: 'NyaaSi' }
    }));
    // the path contains the torrent title, so only the episode is shown
    assert.equal(stream.title.split('\n')[1], 'E03');
  });

  it('does not repeat the episode of single episode releases', () => {
    const stream = toStreamInfo(seriesRecord({
      title: 'The.Office.US.S05E14.Stress.Relief.720p.WEB-DL.DD5.1.H.264.mkv',
      imdbSeason: 5,
      imdbEpisode: 14,
      size: 30 * GB,
      torrent: { title: 'The.Office.US.S05E14.Stress.Relief.720p.WEB-DL.DD5.1.H.264' }
    }));
    assert.equal(stream.title, 'The.Office.US.S05E14.Stress.Relief.720p.WEB-DL.DD5.1.H.264\n👤 42 💾 30 GB ⚙️ RARBG');
  });

  it('keeps the original file line for movies inside collections', () => {
    const stream = toStreamInfo(movieRecord('Marvel Cinematic Universe Collection 1080p', {
      fileIndex: 4,
      title: 'MCU/Iron.Man.2008.1080p.BluRay.x264.mkv',
      torrent: { size: 60 * GB }
    }));
    assert.equal(stream.title.split('\n')[1], 'MCU/Iron.Man.2008.1080p.BluRay.x264.mkv');
  });

  it('displays languages as text instead of flags', () => {
    const stream = toStreamInfo(movieRecord('Some.Movie.2020.MULTi.1080p.BluRay.x264-GROUP', {
      torrent: { languages: 'portuguese,spanish' }
    }));
    assert.doesNotMatch(stream.title, FLAG_REGEX);
    assert.equal(stream.title.split('\n').pop(), '🌐 Multi Audio · Portuguese · Spanish');
  });

  it('distinguishes languages that previously shared a flag', () => {
    const stream = toStreamInfo(movieRecord('Movie.Name.2019.1080p.WEB-DL.Hindi.Tamil.Telugu.x264'));
    assert.equal(stream.title.split('\n').pop(), '🌐 Hindi · Telugu · Tamil');
  });

  it('hides english only and japanese anime languages as before', () => {
    assert.doesNotMatch(toStreamInfo(movieRecord('Movie.2020.ENGLISH.1080p')).title, /🌐/);
    const anime = toStreamInfo(seriesRecord({
      kitsuId: 1,
      kitsuEpisode: 5,
      imdbSeason: undefined,
      imdbEpisode: undefined,
      title: '[SubsPlease] Frieren - 05 (1080p).mkv',
      torrent: { title: '[SubsPlease] Frieren - 05 (1080p) [JAPANESE]', type: 'anime', provider: 'NyaaSi' }
    }));
    assert.doesNotMatch(anime.title, /🌐|Japanese/);
  });
});

describe('stripFlags', () => {
  it('removes country and subdivision flags only', () => {
    assert.equal(stripFlags('Film 🇫🇷 🇬🇧 2020 🏴󠁧󠁢󠁳󠁣󠁴󠁿'), 'Film 2020');
    assert.equal(stripFlags('Ну, погоди! (1969) 👤'), 'Ну, погоди! (1969) 👤');
    assert.equal(stripFlags(undefined), undefined);
  });
});

describe('toStreamInfo compatibility', () => {
  it('keeps the seeders, size and provider extractable', () => {
    const stream = toStreamInfo(seriesRecord({ torrent: { languages: 'french' } }));
    assert.equal(extractSeeders(stream.title), 42);
    assert.equal(extractSize(stream.title), 2 * GB);
    assert.equal(extractProvider(stream.title), 'RARBG');
  });

  it('keeps playback fields unchanged', () => {
    const record = seriesRecord();
    const stream = toStreamInfo(record);
    assert.equal(stream.infoHash, record.infoHash);
    assert.equal(stream.fileIdx, 2);
    assert.deepEqual(stream.behaviorHints, {
      bingeGroup: `torrentio|${record.infoHash}`,
      filename: 'Breaking.Bad.S02E03.Bit.by.a.Dead.Bee.1080p.WEB-DL.DD5.1.H.264-NTb.mkv'
    });
    assert.deepEqual(toStreamInfo(movieRecord('Movie.2020.1080p.BluRay.x264')).sources,
        ['tracker:udp://tracker.example:1337/announce', `dht:${'a'.repeat(40)}`]);
  });

  it('resolves debrid filenames exactly as before', () => {
    const raw = 'Apollo.13.1995.iNTERNAL.AC3.DVDRip.XviD-SHiTHEADS';
    const stream = toStreamInfo(movieRecord(raw));
    assert.equal(stream.releaseName, undefined, 'no internal field needed without flags');
    assert.equal(streamFilename(stream), encodeURIComponent(raw));
    assert.equal(streamFilename(toStreamInfo(movieRecord('Movie, Name (2020) 1080p'))),
        encodeURIComponent('Movie Name (2020) 1080p'));
    const series = toStreamInfo(seriesRecord());
    assert.equal(streamFilename(series), encodeURIComponent(series.behaviorHints.filename));
  });

  it('resolves debrid filenames from the raw name when flags were removed', () => {
    const raw = '🇧🇷 Tropa de Elite 2007 1080p';
    const stream = toStreamInfo(movieRecord(raw));
    assert.equal(stream.releaseName, raw);
    assert.equal(streamFilename(stream), encodeURIComponent(raw));
    const [cleaned] = stripInternalInfo([stream]);
    assert.ok(!('releaseName' in cleaned));
    assert.equal(cleaned.title, stream.title);
  });

  it('still resolves debrid filenames for legacy cached streams', () => {
    const legacy = { title: 'Apollo.13.1995.DVDRip\n👤 7 💾 1.4 GB ⚙️ 1337x\n🇬🇧 / 🇫🇷' };
    assert.equal(streamFilename(legacy), encodeURIComponent('Apollo.13.1995.DVDRip'));
  });
});

describe('language preference and filters', () => {
  it('matches preferred languages on the text line', () => {
    const stream = toStreamInfo(movieRecord('Movie.2020.1080p.WEB-DL', { torrent: { languages: 'russian' } }));
    assert.ok(containsLanguage(stream, ['russian']));
    assert.ok(!containsLanguage(stream, ['french']));
  });

  it('does not match language words appearing in the release name', () => {
    const stream = toStreamInfo(movieRecord('The.Spanish.Prisoner.1997.1080p.BluRay'));
    assert.ok(!containsLanguage(stream, ['spanish']));
  });

  it('matches preferred languages on legacy cached flag titles', () => {
    assert.ok(containsLanguage({ title: 'Movie\n👤 1 💾 1 GB ⚙️ Rutor\n🇷🇺 / 🇬🇧' }, ['russian']));
    assert.ok(!containsLanguage({ title: 'Movie\n👤 1 💾 1 GB ⚙️ Rutor\n🇷🇺' }, ['french']));
  });

  it('sorts preferred language streams first', () => {
    const plain = toStreamInfo(movieRecord('Movie.2020.1080p.WEB-DL', { infoHash: '1'.repeat(40) }));
    const russian = toStreamInfo(movieRecord('Movie.2020.720p.WEB-DL', {
      infoHash: '2'.repeat(40),
      torrent: { languages: 'russian' }
    }));
    const sorted = sortStreams([plain, russian], { language: ['russian'] }, 'movie');
    assert.deepEqual(sorted.map(stream => stream.infoHash), [russian.infoHash, plain.infoHash]);
  });

  it('applies provider, quality and size filters as before', () => {
    const hd = toStreamInfo(movieRecord('Movie.2020.1080p.BluRay.x264', { infoHash: '1'.repeat(40) }));
    const uhd = toStreamInfo(movieRecord('Movie.2020.2160p.WEB-DL.DV.HDR.H.265', {
      infoHash: '2'.repeat(40),
      size: 20 * GB,
      torrent: { provider: 'YTS', size: 20 * GB }
    }));
    const hashes = streams => streams.map(stream => stream.infoHash);
    assert.deepEqual(hashes(applyFilters([hd, uhd], { qualityfilter: ['4k'] })), [hd.infoHash]);
    assert.deepEqual(hashes(applyFilters([hd, uhd], { qualityfilter: ['hdrall'] })), [hd.infoHash]);
    assert.deepEqual(hashes(applyFilters([hd, uhd], { providers: ['yts'] })), [uhd.infoHash]);
    assert.deepEqual(hashes(applyFilters([hd, uhd], { sizefilter: ['5GB'], type: 'movie' })), [hd.infoHash]);
  });
});
