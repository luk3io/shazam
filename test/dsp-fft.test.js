const test = require('node:test');
const assert = require('node:assert');
const { fft } = require('../src/dsp.js');

test('fft puts energy of a pure cosine in the expected bin', () => {
  const N = 64, k = 5;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let n = 0; n < N; n++) re[n] = Math.cos(2 * Math.PI * k * n / N);
  fft(re, im);
  const mag = i => Math.hypot(re[i], im[i]);
  let peak = 1;
  for (let i = 1; i < N / 2; i++) if (mag(i) > mag(peak)) peak = i;
  assert.strictEqual(peak, k);
});
