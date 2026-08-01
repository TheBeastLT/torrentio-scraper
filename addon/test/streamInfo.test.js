import { test } from 'node:test';
import assert from 'node:assert/strict';

// repository.js instantiates Sequelize on import, so a placeholder is needed
// to test stream conversion without a real database connection.
process.env.DATABASE_URI = process.env.DATABASE_URI || 'postgres://localhost:5432/torrentio';
const { toStreamInfo } = await import('../lib/streamInfo.js');

function movieRecord(title, provider = '1337x') {
  return {
    title: `${title}.mkv`,
    size: 12000000000,
    fileIndex: null,
    imdbId: 'tt0000001',
    torrent: {
      title: title,
      provider: provider,
      seeders: 50,
      size: 12000000000,
      type: 'movie',
      trackers: 'udp://tracker.example.org:1337/announce'
    },
    infoHash: '1234567890123456789012345678901234567890'
  };
}

test('marks Polish MULTi release from a Polish group with the Polish flag', () => {
  const stream = toStreamInfo(movieRecord('Diuna.Czesc.Druga.2024.MULTi.1080p.BluRay.x264-KiT'));
  assert.ok(stream.title.includes('🇵🇱'), `title should contain Polish flag:\n${stream.title}`);
});

test('marks MULTi release from a Polish provider with the Polish flag', () => {
  const stream = toStreamInfo(movieRecord('Dune.Part.Two.2024.MULTi.2160p.UHD.BluRay.x265', 'BestTorrents'));
  assert.ok(stream.title.includes('🇵🇱'), `title should contain Polish flag:\n${stream.title}`);
});

test('does not duplicate the Polish flag when parse-torrent-title already detects it', () => {
  const stream = toStreamInfo(movieRecord('Znachor.2023.1080p.NF.WEB-DL.Lektor.PL'));
  const flagCount = stream.title.split('🇵🇱').length - 1;
  assert.equal(flagCount, 1, `title should contain exactly one Polish flag:\n${stream.title}`);
});

test('does not mark generic MULTi releases with the Polish flag', () => {
  const stream = toStreamInfo(movieRecord('Deadpool.3.2024.MULTi.1080p.WEB.H264-FLUX'));
  assert.ok(!stream.title.includes('🇵🇱'), `title should not contain Polish flag:\n${stream.title}`);
});

test('does not mark plain English releases with the Polish flag', () => {
  const stream = toStreamInfo(movieRecord('The.Matrix.1999.1080p.BluRay.x264-RARBG'));
  assert.ok(!stream.title.includes('🇵🇱'), `title should not contain Polish flag:\n${stream.title}`);
});
