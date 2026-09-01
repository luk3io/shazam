const test = require('node:test');
const assert = require('node:assert');
const { findPeaks } = require('../src/dsp.js');

function synthSpec(numFrames, numBins, points) {
  const columns = [];
  for (let t = 0; t < numFrames; t++) columns.push(new Float32Array(numBins));
  for (const { t, f, mag } of points) columns[t][f] = mag;
  return { columns, numFrames, numBins };
}

test('findPeaks recovers implanted maxima', () => {
  const spec = synthSpec(20, 64, [{ t: 5, f: 10, mag: 9 }, { t: 12, f: 40, mag: 7 }]);
  const peaks = findPeaks(spec);
  assert.ok(peaks.some(p => p.t === 5 && p.f === 10));
  assert.ok(peaks.some(p => p.t === 12 && p.f === 40));
});
