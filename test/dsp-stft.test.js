const test = require('node:test');
const assert = require('node:assert');
const { stft, CONFIG } = require('../src/dsp.js');
const { tone } = require('./helpers.js');

test('stft of a steady tone peaks at the tone bin', () => {
  const freq = 1000;
  const spec = stft(tone(freq, 1.0));
  assert.ok(spec.numFrames > 5);
  const expectedBin = Math.round(freq / (CONFIG.sampleRate / CONFIG.frameSize));
  const mid = spec.columns[Math.floor(spec.numFrames / 2)];
  let peak = 0;
  for (let b = 1; b < spec.numBins; b++) if (mid[b] > mid[peak]) peak = b;
  assert.ok(Math.abs(peak - expectedBin) <= 1, `peak ${peak} vs ${expectedBin}`);
});
