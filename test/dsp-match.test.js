const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/dsp.js');
const { sequence } = require('./helpers.js');

const fpOf = pcm => D.fingerprint(D.findPeaks(D.stft(pcm)));

test('a clip taken from song A matches song A, not song B', () => {
  const songA = sequence([{ freq: 440, seconds: 2 }, { freq: 660, seconds: 2 }, { freq: 550, seconds: 2 }, { freq: 880, seconds: 2 }]);
  const songB = sequence([{ freq: 300, seconds: 2 }, { freq: 500, seconds: 2 }, { freq: 700, seconds: 2 }, { freq: 900, seconds: 2 }]);
  const db = D.buildDatabase([{ songId: 'A', fingerprints: fpOf(songA) }, { songId: 'B', fingerprints: fpOf(songB) }]);
  const sr = D.CONFIG.sampleRate;
  const clip = songA.slice(1 * sr, 4 * sr);
  const results = D.matchQuery(fpOf(clip), db);
  assert.strictEqual(results[0].songId, 'A');
  assert.ok(results[0].score >= D.CONFIG.minScore);
  if (results[1]) assert.ok(results[0].score > results[1].score);
});
