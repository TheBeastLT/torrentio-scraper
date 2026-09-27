import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectPolishRelease, Confidence } from '../lib/polishDetection.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/polishReleases.json', import.meta.url)));

test('detects Polish releases', async t => {
  for (const fixture of fixtures.positive) {
    await t.test(fixture.name, () => {
      const result = detectPolishRelease(fixture.name, { provider: fixture.provider });
      assert.equal(result.isPolish, true, `expected Polish, signals: ${result.signals}`);
      assert.equal(result.confidence, fixture.expectedConfidence, `signals: ${result.signals}`);
      for (const [tag, expected] of Object.entries(fixture.expectedTags || {})) {
        assert.equal(result.tags[tag], expected, `expected tag ${tag}=${expected}`);
      }
    });
  }
});

test('does not flag non-Polish releases', async t => {
  for (const fixture of fixtures.negative) {
    await t.test(fixture.name, () => {
      const result = detectPolishRelease(fixture.name, { provider: fixture.provider });
      assert.equal(result.isPolish, false, `expected not Polish, signals: ${result.signals}`);
      assert.equal(result.confidence, fixture.expectedConfidence, `signals: ${result.signals}`);
    });
  }
});

test('handles empty input', () => {
  const result = detectPolishRelease(undefined);
  assert.equal(result.isPolish, false);
  assert.equal(result.confidence, Confidence.NONE);
  assert.deepEqual(result.signals, []);
});

test('reports matched signals and score', () => {
  const result = detectPolishRelease('Kler.2018.PL.1080p.WEB-DL.x264-PSiG');
  assert.ok(result.signals.includes('language-tag'));
  assert.ok(result.signals.includes('release-group'));
  assert.ok(result.score >= 4);
});
