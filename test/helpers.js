const { CONFIG } = require('../src/dsp.js');
// Generate a pure sine tone as Float32 PCM.
function tone(freq, seconds, sr = CONFIG.sampleRate) {
  const n = Math.floor(seconds * sr), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * freq * i / sr);
  return out;
}
module.exports = { tone };
