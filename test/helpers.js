const { CONFIG } = require('../src/dsp.js');
// Generate a pure sine tone as Float32 PCM.
function tone(freq, seconds, sr = CONFIG.sampleRate) {
  const n = Math.floor(seconds * sr), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * freq * i / sr);
  return out;
}
// Concatenate an array of { freq, seconds } into one Float32Array.
function sequence(notes, sr = CONFIG.sampleRate) {
  const parts = notes.map(nt => tone(nt.freq, nt.seconds, sr));
  const len = parts.reduce((s, p) => s + p.length, 0), out = new Float32Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
module.exports = { tone, sequence };
