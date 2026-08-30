# Shazam Pipeline Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single self-contained `.html` file that visually walks an audience through Shazam's 6-stage recognition pipeline and performs a real match (live mic or canned clip) against a small local database of 5 embedded songs.

**Architecture:** Pure-JS DSP core (FFT → spectrogram → peaks → fingerprint hashing → offset-vote matching) written to run in both Node (for tests) and the browser (via classic `<script>`). A browser audio layer decodes embedded MP3s and captures the mic. A stage controller precomputes everything up front, then drives six canvas renderers with spacebar. A Node build script bakes the DSP/UI code + base64-encoded songs into one deliverable HTML file.

**Tech Stack:** Vanilla JavaScript, HTML Canvas 2D, Web Audio API, Node 18+ (build + `node:test`). No third-party libraries anywhere.

## Global Constraints

- **Single self-contained deliverable:** output is one `shazam-demo.html`, opened by double-click (`file://`), fully offline. No servers, no network, no CDN.
- **No external libraries** — including the FFT; everything is hand-written vanilla JS.
- **Cross-platform:** must open on Windows and Mac. Live mic recommended in Chrome/Edge (Safari often blocks `getUserMedia` on `file://`); canned works everywhere.
- **Dual-runtime JS modules:** every file in `src/*.js` (except browser-only `audio.js`/`renderers.js`/`controller.js`) uses the CommonJS-or-global wrapper so the same source runs under `node --test` and as a browser `<script>`.
- **Precompute-then-replay:** all heavy DSP runs before stepping begins; per-stage animation only replays precomputed data.
- **Songs:** 5 MP3s in `./songs/` (git-ignored), named `Artist - Song title.mp3`; metadata parsed from filename. Full songs embedded (~30–35 MB output).
- **DSP config (shared constants, defined once in `src/dsp.js`):** `sampleRate: 11025`, `frameSize: 1024`, `hopSize: 512`, `peakNeighborhoodTime: 3`, `peakNeighborhoodFreq: 3`, `peaksPerFrameCap: 5`, `targetZoneMinDt: 1`, `targetZoneMaxDt: 63`, `targetZoneFreqRange: 200`, `fanout: 8`, `minScore: 5`. These are tunable during rehearsal.

## File Structure

- `package.json` — test script only (`node --test`), no dependencies, `"type": "commonjs"`.
- `src/dsp.js` — DSP core, dual-runtime. Exports `{ CONFIG, fft, hann, stft, findPeaks, fingerprint, buildDatabase, matchQuery }`.
- `src/audio.js` — browser audio: `AudioIO.{ decodeToMono, base64ToArrayBuffer, sliceSeconds, captureMic, makeSource }`.
- `src/renderers.js` — six stage renderers under `Renderers.{ waveform, fourier, spectrogram, peaks, fingerprints, matching }`.
- `src/controller.js` — app state machine, precompute orchestration, keyboard, mode select, self-test hook.
- `src/styles.css` — dark projector theme.
- `src/template.html` — HTML shell with `/*__STYLES__*/`, `/*__SONGS__*/`, `/*__SCRIPT__*/` placeholders.
- `build.mjs` — Node build: reads `./songs/*.mp3`, parses metadata, base64-embeds, inlines all `src` files into `shazam-demo.html`.
- `test/*.test.js` — Node unit tests for the DSP core.
- `test/helpers.js` — synthetic-PCM generators for tests.
- `README.md` — run/rehearsal notes.

---

### Task 1: Scaffold + FFT

**Files:**
- Create: `package.json`, `src/dsp.js`, `test/dsp-fft.test.js`

**Interfaces:**
- Produces: `require('../src/dsp.js')` → `{ CONFIG, fft }`. `fft(re, im)` mutates two equal-length `Float64Array`s (length a power of 2) in place, replacing them with the DFT (real and imaginary parts).

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "shazam-demo",
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": { "test": "node --test", "build": "node build.mjs" }
}
```

- [ ] **Step 2: Write the failing test** — `test/dsp-fft.test.js`

```js
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
```

- [ ] **Step 3: Run test to verify it fails** — Run: `npm test`. Expected: FAIL (Cannot find module `../src/dsp.js`).

- [ ] **Step 4: Write minimal implementation** — `src/dsp.js`

```js
(function (root) {
  const CONFIG = {
    sampleRate: 11025, frameSize: 1024, hopSize: 512,
    peakNeighborhoodTime: 3, peakNeighborhoodFreq: 3, peaksPerFrameCap: 5,
    targetZoneMinDt: 1, targetZoneMaxDt: 63, targetZoneFreqRange: 200,
    fanout: 8, minScore: 5,
  };

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let tr = re[i]; re[i] = re[j]; re[j] = tr;
        let ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cwr = 1, cwi = 0;
        for (let k = 0; k < len / 2; k++) {
          const aRe = re[i + k], aIm = im[i + k];
          const bRe = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
          const bIm = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
          re[i + k] = aRe + bRe; im[i + k] = aIm + bIm;
          re[i + k + len / 2] = aRe - bRe; im[i + k + len / 2] = aIm - bIm;
          const ncwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr; cwr = ncwr;
        }
      }
    }
  }

  const DSP = { CONFIG, fft };
  if (typeof module !== 'undefined' && module.exports) module.exports = DSP;
  else root.DSP = DSP;
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 5: Run test to verify it passes** — Run: `npm test`. Expected: PASS.

- [ ] **Step 6: Commit** — `git add package.json src/dsp.js test/dsp-fft.test.js && git commit -m "feat: DSP core scaffold with radix-2 FFT"`

---

### Task 2: STFT / spectrogram + Hann window

**Files:**
- Modify: `src/dsp.js` (add `hann`, `stft` to the object)
- Create: `test/dsp-stft.test.js`, `test/helpers.js`

**Interfaces:**
- Consumes: `fft`, `CONFIG`.
- Produces: `hann(n) -> Float64Array`. `stft(pcm, cfg=CONFIG) -> { columns: Float32Array[], numFrames, numBins }` where each column has `numBins = frameSize/2` magnitudes. `test/helpers.js` exports `tone(freq, seconds, sr)` and `sequence(notes, sr)` (see Task 5) returning `Float32Array` PCM.

- [ ] **Step 1: Write `test/helpers.js`**

```js
const { CONFIG } = require('../src/dsp.js');
function tone(freq, seconds, sr = CONFIG.sampleRate) {
  const n = Math.floor(seconds * sr), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * freq * i / sr);
  return out;
}
module.exports = { tone };
```

- [ ] **Step 2: Write the failing test** — `test/dsp-stft.test.js`

```js
const test = require('node:test');
const assert = require('node:assert');
const { stft, CONFIG } = require('../src/dsp.js');
const { tone } = require('./helpers.js');

test('stft of a steady tone peaks at the tone bin in every frame', () => {
  const freq = 1000;
  const spec = stft(tone(freq, 1.0));
  assert.ok(spec.numFrames > 5);
  const expectedBin = Math.round(freq / (CONFIG.sampleRate / CONFIG.frameSize));
  const mid = spec.columns[Math.floor(spec.numFrames / 2)];
  let peak = 0;
  for (let b = 1; b < spec.numBins; b++) if (mid[b] > mid[peak]) peak = b;
  assert.ok(Math.abs(peak - expectedBin) <= 1, `peak ${peak} vs ${expectedBin}`);
});
```

- [ ] **Step 3: Run test to verify it fails** — Run: `npm test`. Expected: FAIL (`stft is not a function`).

- [ ] **Step 4: Add implementation to `src/dsp.js`** (inside the IIFE, before the `DSP` object)

```js
function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
  return w;
}
function stft(pcm, cfg = CONFIG) {
  const { frameSize, hopSize } = cfg;
  const win = hann(frameSize), numBins = frameSize / 2;
  const numFrames = Math.max(0, 1 + Math.floor((pcm.length - frameSize) / hopSize));
  const columns = [];
  const re = new Float64Array(frameSize), im = new Float64Array(frameSize);
  for (let f = 0; f < numFrames; f++) {
    const off = f * hopSize;
    for (let i = 0; i < frameSize; i++) { re[i] = pcm[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const col = new Float32Array(numBins);
    for (let b = 0; b < numBins; b++) col[b] = Math.hypot(re[b], im[b]);
    columns.push(col);
  }
  return { columns, numFrames, numBins };
}
```

Then extend the export object: `const DSP = { CONFIG, fft, hann, stft };`

- [ ] **Step 5: Run test to verify it passes** — Run: `npm test`. Expected: PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: Hann window + STFT spectrogram"`

---

### Task 3: Peak detection

**Files:**
- Modify: `src/dsp.js` (add `findPeaks`)
- Create: `test/dsp-peaks.test.js`

**Interfaces:**
- Consumes: `stft` output shape, `CONFIG`.
- Produces: `findPeaks(spec, cfg=CONFIG) -> Array<{ t, f, mag }>` (t = frame index, f = bin index), local maxima in a time×frequency neighborhood, capped at `peaksPerFrameCap` strongest per frame.

- [ ] **Step 1: Write the failing test** — `test/dsp-peaks.test.js`

```js
const test = require('node:test');
const assert = require('node:assert');
const { findPeaks, CONFIG } = require('../src/dsp.js');

function synthSpec(numFrames, numBins, points) {
  const columns = [];
  for (let t = 0; t < numFrames; t++) columns.push(new Float32Array(numBins));
  for (const { t, f, mag } of points) columns[t][f] = mag;
  return { columns, numFrames, numBins };
}

test('findPeaks recovers implanted maxima', () => {
  const spec = synthSpec(20, 64, [
    { t: 5, f: 10, mag: 9 }, { t: 12, f: 40, mag: 7 },
  ]);
  const peaks = findPeaks(spec);
  assert.ok(peaks.some(p => p.t === 5 && p.f === 10));
  assert.ok(peaks.some(p => p.t === 12 && p.f === 40));
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npm test`. Expected: FAIL (`findPeaks is not a function`).

- [ ] **Step 3: Add implementation to `src/dsp.js`**

```js
function findPeaks(spec, cfg = CONFIG) {
  const { columns, numFrames, numBins } = spec;
  const dt = cfg.peakNeighborhoodTime, df = cfg.peakNeighborhoodFreq, peaks = [];
  for (let t = 0; t < numFrames; t++) {
    const col = columns[t], cand = [];
    for (let b = 1; b < numBins - 1; b++) {
      const v = col[b];
      if (v <= 0 || v < col[b - 1] || v < col[b + 1]) continue;
      let isMax = true;
      for (let tt = Math.max(0, t - dt); tt <= Math.min(numFrames - 1, t + dt) && isMax; tt++) {
        const c2 = columns[tt];
        for (let bb = Math.max(0, b - df); bb <= Math.min(numBins - 1, b + df); bb++) {
          if (c2[bb] > v) { isMax = false; break; }
        }
      }
      if (isMax) cand.push({ t, f: b, mag: v });
    }
    cand.sort((a, b) => b.mag - a.mag);
    for (let i = 0; i < Math.min(cfg.peaksPerFrameCap, cand.length); i++) peaks.push(cand[i]);
  }
  return peaks;
}
```

Extend export: `const DSP = { CONFIG, fft, hann, stft, findPeaks };`

- [ ] **Step 4: Run test to verify it passes** — Run: `npm test`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: local-maximum peak detection"`

---

### Task 4: Fingerprint hashing

**Files:**
- Modify: `src/dsp.js` (add `fingerprint`)
- Create: `test/dsp-fingerprint.test.js`

**Interfaces:**
- Consumes: peak list from `findPeaks`, `CONFIG`.
- Produces: `fingerprint(peaks, cfg=CONFIG) -> Array<{ hash, t }>` where `hash` is an unsigned 32-bit int packing `(f1<<23)|(f2<<14)|dt` and `t` is the anchor frame index. Deterministic for a given peak list.

- [ ] **Step 1: Write the failing test** — `test/dsp-fingerprint.test.js`

```js
const test = require('node:test');
const assert = require('node:assert');
const { fingerprint } = require('../src/dsp.js');

const peaks = [
  { t: 0, f: 10, mag: 1 }, { t: 3, f: 20, mag: 1 }, { t: 5, f: 15, mag: 1 },
];

test('fingerprint is deterministic and pairs anchors forward', () => {
  const a = fingerprint(peaks), b = fingerprint(peaks);
  assert.deepStrictEqual(a, b);
  assert.ok(a.length > 0);
  assert.ok(a.every(fp => fp.hash >= 0 && fp.hash <= 0xFFFFFFFF));
  assert.ok(a.every(fp => Number.isInteger(fp.hash)));
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npm test`. Expected: FAIL (`fingerprint is not a function`).

- [ ] **Step 3: Add implementation to `src/dsp.js`**

```js
function fingerprint(peaks, cfg = CONFIG) {
  const pts = [...peaks].sort((a, b) => a.t - b.t || a.f - b.f), fps = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]; let paired = 0;
    for (let j = i + 1; j < pts.length && paired < cfg.fanout; j++) {
      const b = pts[j], dt = b.t - a.t;
      if (dt < cfg.targetZoneMinDt) continue;
      if (dt > cfg.targetZoneMaxDt) break;
      if (Math.abs(b.f - a.f) > cfg.targetZoneFreqRange) continue;
      const hash = (((a.f & 0x1FF) << 23) | ((b.f & 0x1FF) << 14) | (dt & 0x3FFF)) >>> 0;
      fps.push({ hash, t: a.t }); paired++;
    }
  }
  return fps;
}
```

Extend export: add `fingerprint`.

- [ ] **Step 4: Run test to verify it passes** — Run: `npm test`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: peak-pair fingerprint hashing"`

---

### Task 5: Database + matching (end-to-end DSP)

**Files:**
- Modify: `src/dsp.js` (add `buildDatabase`, `matchQuery`), `test/helpers.js` (add `sequence`)
- Create: `test/dsp-match.test.js`

**Interfaces:**
- Consumes: `fingerprint` output, `CONFIG`.
- Produces:
  - `buildDatabase(perSong) -> Map<hash, Array<{songId, t}>>`, where `perSong` is `Array<{ songId, fingerprints }>`.
  - `matchQuery(queryFps, db, cfg=CONFIG) -> Array<{ songId, score, offset }>` sorted by `score` desc (score = votes in the best time-offset bin).
  - `sequence(notes, sr)` in helpers: `notes` is `Array<{ freq, seconds }>` concatenated into one `Float32Array`.

- [ ] **Step 1: Add `sequence` to `test/helpers.js`**

```js
function sequence(notes, sr = CONFIG.sampleRate) {
  const parts = notes.map(nt => tone(nt.freq, nt.seconds, sr));
  const len = parts.reduce((s, p) => s + p.length, 0), out = new Float32Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
module.exports = { tone, sequence };
```

- [ ] **Step 2: Write the failing test** — `test/dsp-match.test.js`

```js
const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/dsp.js');
const { sequence } = require('./helpers.js');

function fpOf(pcm) { return D.fingerprint(D.findPeaks(D.stft(pcm))); }

test('a clip taken from song A matches song A, not song B', () => {
  const songA = sequence([
    { freq: 440, seconds: 2 }, { freq: 660, seconds: 2 },
    { freq: 550, seconds: 2 }, { freq: 880, seconds: 2 },
  ]);
  const songB = sequence([
    { freq: 300, seconds: 2 }, { freq: 500, seconds: 2 },
    { freq: 700, seconds: 2 }, { freq: 900, seconds: 2 },
  ]);
  const db = D.buildDatabase([
    { songId: 'A', fingerprints: fpOf(songA) },
    { songId: 'B', fingerprints: fpOf(songB) },
  ]);
  const sr = D.CONFIG.sampleRate;
  const clip = songA.slice(1 * sr, 4 * sr); // 3s from the middle of A
  const results = D.matchQuery(fpOf(clip), db);
  assert.strictEqual(results[0].songId, 'A');
  assert.ok(results[0].score >= D.CONFIG.minScore);
  if (results[1]) assert.ok(results[0].score > results[1].score);
});
```

- [ ] **Step 3: Run test to verify it fails** — Run: `npm test`. Expected: FAIL (`buildDatabase is not a function`).

- [ ] **Step 4: Add implementation to `src/dsp.js`**

```js
function buildDatabase(perSong) {
  const db = new Map();
  for (const { songId, fingerprints } of perSong)
    for (const { hash, t } of fingerprints) {
      let arr = db.get(hash); if (!arr) { arr = []; db.set(hash, arr); }
      arr.push({ songId, t });
    }
  return db;
}
function matchQuery(queryFps, db, cfg = CONFIG) {
  const votes = new Map();
  for (const { hash, t } of queryFps) {
    const arr = db.get(hash); if (!arr) continue;
    for (const { songId, t: td } of arr) {
      const offset = td - t;
      let m = votes.get(songId); if (!m) { m = new Map(); votes.set(songId, m); }
      m.set(offset, (m.get(offset) || 0) + 1);
    }
  }
  const results = [];
  for (const [songId, m] of votes) {
    let best = 0, bestOff = 0;
    for (const [off, c] of m) if (c > best) { best = c; bestOff = off; }
    results.push({ songId, score: best, offset: bestOff });
  }
  return results.sort((a, b) => b.score - a.score);
}
```

Extend export to the full set: `{ CONFIG, fft, hann, stft, findPeaks, fingerprint, buildDatabase, matchQuery }`.

- [ ] **Step 5: Run test to verify it passes** — Run: `npm test`. Expected: PASS (all DSP tests green).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: fingerprint database + offset-vote matching"`

---

### Task 6: Browser audio layer

**Files:**
- Create: `src/audio.js`

**Interfaces:**
- Consumes: global `DSP.CONFIG` (loaded as a prior `<script>`).
- Produces global `AudioIO`:
  - `base64ToArrayBuffer(b64) -> ArrayBuffer`
  - `decodeToMono(arrayBuffer) -> Promise<Float32Array>` at `DSP.CONFIG.sampleRate`, mono.
  - `sliceSeconds(pcm, startSec, durSec, sr=DSP.CONFIG.sampleRate) -> Float32Array`
  - `captureMic(seconds, onLevel) -> Promise<Float32Array>` — records from mic, calls `onLevel(0..1)` ~30×/s during capture, returns decoded mono PCM.
  - `makeSource(pcm, sr) -> { play(), stop() }` — plays a Float32Array via Web Audio for stage-1 audio.

Browser-only APIs; verified in Task 8+ via the browser, not `node --test`.

- [ ] **Step 1: Write `src/audio.js`**

```js
(function (root) {
  const SR = () => root.DSP.CONFIG.sampleRate;
  function base64ToArrayBuffer(b64) {
    const bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  async function decodeToMono(arrayBuffer) {
    const Ctx = root.AudioContext || root.webkitAudioContext;
    const tmp = new Ctx();
    const decoded = await tmp.decodeAudioData(arrayBuffer.slice(0));
    tmp.close();
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * SR()), SR());
    const src = off.createBufferSource();
    src.buffer = decoded; src.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    return rendered.getChannelData(0).slice();
  }
  function sliceSeconds(pcm, startSec, durSec, sr = SR()) {
    const a = Math.floor(startSec * sr), b = Math.min(pcm.length, a + Math.floor(durSec * sr));
    return pcm.slice(a, b);
  }
  async function captureMic(seconds, onLevel) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const Ctx = root.AudioContext || root.webkitAudioContext;
    const ac = new Ctx();
    const srcNode = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser(); analyser.fftSize = 512;
    srcNode.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let raf = 0;
    const meter = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0; for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
      if (onLevel) onLevel(peak);
      raf = requestAnimationFrame(meter);
    };
    meter();
    const rec = new MediaRecorder(stream), chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    const stopped = new Promise(res => (rec.onstop = res));
    rec.start();
    await new Promise(r => setTimeout(r, seconds * 1000));
    rec.stop(); await stopped;
    cancelAnimationFrame(raf); ac.close();
    stream.getTracks().forEach(t => t.stop());
    return decodeToMono(await new Blob(chunks).arrayBuffer());
  }
  function makeSource(pcm, sr = SR()) {
    const Ctx = root.AudioContext || root.webkitAudioContext;
    let ac = null, node = null;
    return {
      play() {
        ac = new Ctx();
        const b = ac.createBuffer(1, pcm.length, sr);
        b.copyToChannel(pcm, 0);
        node = ac.createBufferSource(); node.buffer = b;
        node.connect(ac.destination); node.start();
      },
      stop() { try { node && node.stop(); ac && ac.close(); } catch (e) {} },
    };
  }
  root.AudioIO = { base64ToArrayBuffer, decodeToMono, sliceSeconds, captureMic, makeSource };
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 2: Commit** — `git add src/audio.js && git commit -m "feat: browser audio layer (decode, slice, mic capture, playback)"`

---

### Task 7: Build script + HTML shell + self-test hook

**Files:**
- Create: `build.mjs`, `src/template.html`, `src/styles.css`, `src/controller.js` (minimal: DB build + self-test only; full controller in Task 8), `src/renderers.js` (empty placeholder object for now)

**Interfaces:**
- Consumes: `./songs/*.mp3`, all `src/*` files.
- Produces: `shazam-demo.html` at repo root. Exposes `window.__selfTest()` when URL contains `?selftest`, returning `Promise<{ songs, topSongId, topScore }>` — decodes embedded songs, builds the DB, slices 6s from the first song, and self-matches. Used for automated verification.

- [ ] **Step 1: Write `src/styles.css`**

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; background: #0a0a12; color: #e8e8f0;
  font-family: system-ui, -apple-system, Segoe UI, sans-serif; overflow: hidden; }
#app { height: 100%; display: flex; flex-direction: column; }
#tracker { display: flex; gap: 8px; padding: 14px 20px; }
#tracker .step { flex: 1; text-align: center; padding: 8px; border-radius: 8px;
  background: #16162a; color: #6a6a88; font-size: 15px; font-weight: 600; }
#tracker .step.active { background: #2b2bff; color: #fff; }
#tracker .step.done { color: #9a9ac8; }
#stage { flex: 1; position: relative; }
#stageCanvas { width: 100%; height: 100%; display: block; }
#caption { padding: 12px 24px; font-size: 20px; text-align: center; min-height: 52px; }
#controls { display: flex; gap: 12px; justify-content: center; padding: 0 20px 18px; }
button { font-size: 18px; padding: 12px 22px; border: 0; border-radius: 10px;
  background: #2b2bff; color: #fff; cursor: pointer; font-weight: 600; }
button.secondary { background: #23233a; }
#start { position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 22px; background: #0a0a12; z-index: 10; }
#start h1 { font-size: 42px; } #start .modes { display: flex; gap: 20px; }
#loading { position: absolute; inset: 0; display: none; align-items: center;
  justify-content: center; font-size: 24px; background: rgba(10,10,18,.9); z-index: 20; }
select { font-size: 18px; padding: 10px; border-radius: 8px; }
.hidden { display: none !important; }
```

- [ ] **Step 2: Write `src/renderers.js`** (placeholder to be filled in Tasks 9–10)

```js
(function (root) { root.Renderers = {}; })(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 3: Write minimal `src/controller.js`** (DB build + self-test; replaced/extended in Task 8)

```js
(function (root) {
  const D = root.DSP, IO = root.AudioIO;
  async function loadDatabase(songs) {
    const perSong = [];
    for (const s of songs) {
      const pcm = await IO.decodeToMono(IO.base64ToArrayBuffer(s.data));
      s._pcm = pcm;
      perSong.push({ songId: s.id, fingerprints: D.fingerprint(D.findPeaks(D.stft(pcm))) });
    }
    return D.buildDatabase(perSong);
  }
  root.App = { loadDatabase };

  if (location.search.includes('selftest')) {
    root.__selfTest = async () => {
      const db = await loadDatabase(root.SONGS);
      const first = root.SONGS[0];
      const clip = IO.sliceSeconds(first._pcm, 10, 6);
      const res = D.matchQuery(D.fingerprint(D.findPeaks(D.stft(clip))), db);
      return { songs: root.SONGS.length, topSongId: res[0] && res[0].songId, topScore: res[0] && res[0].score, expected: first.id };
    };
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Write `src/template.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>How Shazam Works</title>
<style>/*__STYLES__*/</style>
</head>
<body>
<div id="app">
  <div id="tracker"></div>
  <div id="stage">
    <canvas id="stageCanvas"></canvas>
    <div id="start">
      <h1>How Shazam Works</h1>
      <div class="modes">
        <button id="modeLive">🎤 Live (mic)</button>
        <div>
          <select id="songSelect"></select>
          <button id="modeCanned">▶ Canned playback</button>
        </div>
      </div>
      <button class="secondary" id="fsBtn">⛶ Fullscreen</button>
    </div>
    <div id="loading">Analysing… <span id="loadPct"></span></div>
  </div>
  <div id="caption"></div>
  <div id="controls" class="hidden">
    <button class="secondary" id="prevBtn">◀ Prev</button>
    <button id="nextBtn">Next ▶ (Space)</button>
    <button class="secondary" id="replayBtn">↺ Replay (R)</button>
  </div>
</div>
<script>/*__SONGS__*/</script>
<script>/*__SCRIPT__*/</script>
</body>
</html>
```

- [ ] **Step 5: Write `build.mjs`**

```js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SONGS_DIR = 'songs';
const files = readdirSync(SONGS_DIR).filter(f => f.toLowerCase().endsWith('.mp3')).sort();
if (files.length === 0) throw new Error('No .mp3 files in ./songs');
const songs = files.map((f, i) => {
  const base = f.replace(/\.mp3$/i, ''), parts = base.split(' - ');
  const artist = parts.length > 1 ? parts[0].trim() : 'Unknown';
  const title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : base;
  return { id: 's' + i, artist, title, mime: 'audio/mpeg',
    data: readFileSync(join(SONGS_DIR, f)).toString('base64') };
});
const read = p => readFileSync(p, 'utf8');
const bundle = [read('src/dsp.js'), read('src/audio.js'), read('src/renderers.js'), read('src/controller.js')].join('\n\n');
const html = read('src/template.html')
  .replace('/*__STYLES__*/', () => read('src/styles.css'))
  .replace('/*__SONGS__*/', () => 'const SONGS=' + JSON.stringify(songs) + ';')
  .replace('/*__SCRIPT__*/', () => bundle);
writeFileSync('shazam-demo.html', html);
const mb = (Buffer.byteLength(html) / 1048576).toFixed(1);
console.log(`Built shazam-demo.html — ${songs.length} songs, ${mb} MB`);
```

Note: `.replace(pattern, () => text)` uses a replacer function so `$` characters in the embedded content are treated literally.

- [ ] **Step 6: Build and verify with Playwright MCP**

Run: `npm run build`. Expected: prints "Built shazam-demo.html — 5 songs, ~30–35 MB".
Then verify the self-test in a real browser:
- `browser_navigate` to `file:///C:/Code/luke/shazam/shazam-demo.html?selftest`
- `browser_evaluate`: `async () => await window.__selfTest()`
- Expected result: `{ songs: 5, topSongId: 's0', expected: 's0', topScore >= 5 }` (top match equals the song the clip came from).

- [ ] **Step 7: Commit** — `git add build.mjs src/template.html src/styles.css src/renderers.js src/controller.js && git commit -m "feat: build script, HTML shell, DB loader + self-test hook"`

---

### Task 8: Stage controller (state machine, precompute, keyboard, modes)

**Files:**
- Modify: `src/controller.js` (extend into the full controller)

**Interfaces:**
- Consumes: `DSP`, `AudioIO`, `Renderers` (six named renderers, added in Tasks 9–10), `SONGS`, DOM ids from the template.
- Produces: running app. Precomputes a `stageData` object shared by all renderers:
  ```
  stageData = { pcm, sr, spec, peaks, fingerprints, results, songs, matchedSong }
  ```
  Stage list order: `['waveform','fourier','spectrogram','peaks','fingerprints','matching']`. Each renderer is called as `Renderers[name](ctx, stageData, progress, W, H)` with `progress` in `0..1`.

- [ ] **Step 1: Replace `src/controller.js` body** (keep `loadDatabase` + self-test from Task 7; add the controller below the existing code, before the IIFE close)

```js
  const STAGES = [
    ['waveform',    'A microphone records the song as a waveform — air pressure over time.'],
    ['fourier',     'The Fourier transform breaks a short slice into its frequencies.'],
    ['spectrogram', 'Stacking many FFTs over time forms a spectrogram: time × frequency.'],
    ['peaks',       'Keep only the strongest peaks — a constellation that survives noise.'],
    ['fingerprints','Pair peaks into hashes: (f₁, f₂, Δt) → a 32-bit fingerprint.'],
    ['matching',    'Votes for the same song at the same time-offset reveal the match.'],
  ];
  const $ = id => document.getElementById(id);
  const canvas = $('stageCanvas'), ctx = canvas.getContext('2d');
  let stageData = null, db = null, stageIdx = 0, anim = null, animStart = 0, audioSrc = null;

  function resize() {
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width * devicePixelRatio; canvas.height = r.height * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    if (stageData) draw(1);
  }
  window.addEventListener('resize', resize);

  function renderTracker() {
    $('tracker').innerHTML = STAGES.map((s, i) =>
      `<div class="step ${i === stageIdx ? 'active' : i < stageIdx ? 'done' : ''}">${i + 1}. ${s[0]}</div>`).join('');
  }
  function draw(progress) {
    const W = canvas.width / devicePixelRatio, H = canvas.height / devicePixelRatio;
    ctx.clearRect(0, 0, W, H);
    const name = STAGES[stageIdx][0];
    (root.Renderers[name] || (() => {}))(ctx, stageData, progress, W, H);
  }
  function animateStage() {
    cancelAnimationFrame(anim); animStart = performance.now();
    const DUR = 2200;
    const tick = now => {
      const p = Math.min(1, (now - animStart) / DUR);
      const eased = p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      draw(eased);
      if (p < 1) anim = requestAnimationFrame(tick);
    };
    anim = requestAnimationFrame(tick);
  }
  function showStage(i) {
    stageIdx = Math.max(0, Math.min(STAGES.length - 1, i));
    $('caption').textContent = STAGES[stageIdx][1];
    renderTracker(); animateStage();
  }
  function precompute(pcm) {
    const spec = D.stft(pcm), peaks = D.findPeaks(spec), fps = D.fingerprint(peaks);
    const results = D.matchQuery(fps, db);
    const matchedSong = root.SONGS.find(s => s.id === (results[0] && results[0].songId)) || null;
    stageData = { pcm, sr: D.CONFIG.sampleRate, spec, peaks, fingerprints: fps, results, songs: root.SONGS, matchedSong };
  }
  async function beginPipeline(pcm) {
    precompute(pcm);
    $('start').classList.add('hidden'); $('controls').classList.remove('hidden');
    showStage(0);
  }
  async function ensureDb(onPct) {
    if (db) return;
    const perSong = [];
    for (let i = 0; i < root.SONGS.length; i++) {
      const s = root.SONGS[i];
      s._pcm = await IO.decodeToMono(IO.base64ToArrayBuffer(s.data));
      perSong.push({ songId: s.id, fingerprints: D.fingerprint(D.findPeaks(D.stft(s._pcm))) });
      if (onPct) onPct(Math.round(((i + 1) / root.SONGS.length) * 100));
      await new Promise(r => setTimeout(r, 0)); // yield so overlay repaints
    }
    db = D.buildDatabase(perSong);
  }
  function withLoading(fn) {
    return async (...a) => {
      $('loading').style.display = 'flex';
      await ensureDb(p => ($('loadPct').textContent = p + '%'));
      try { await fn(...a); } finally { $('loading').style.display = 'none'; }
    };
  }

  function initUI() {
    root.SONGS.forEach(s => {
      const o = document.createElement('option'); o.value = s.id;
      o.textContent = `${s.artist} — ${s.title}`; $('songSelect').appendChild(o);
    });
    renderTracker();
    $('modeCanned').onclick = withLoading(async () => {
      const s = root.SONGS.find(x => x.id === $('songSelect').value) || root.SONGS[0];
      await beginPipeline(IO.sliceSeconds(s._pcm, 30, 10));
    });
    $('modeLive').onclick = withLoading(async () => {
      $('loading').firstChild.textContent = 'Listening… ';
      const pcm = await IO.captureMic(10, lvl => ($('loadPct').textContent = '▮'.repeat(Math.round(lvl * 20))));
      $('loading').firstChild.textContent = 'Analysing… ';
      await beginPipeline(pcm);
    });
    $('fsBtn').onclick = () => document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    $('nextBtn').onclick = () => showStage(stageIdx + 1);
    $('prevBtn').onclick = () => showStage(stageIdx - 1);
    $('replayBtn').onclick = () => animateStage();
    document.addEventListener('keydown', e => {
      if ($('start').classList.contains('hidden') === false) return;
      if (e.code === 'Space' || e.code === 'ArrowRight') { e.preventDefault(); showStage(stageIdx + 1); }
      else if (e.code === 'ArrowLeft') showStage(stageIdx - 1);
      else if (e.key.toLowerCase() === 'r') animateStage();
    });
    resize();
  }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initUI);
```

- [ ] **Step 2: Build** — Run: `npm run build`. Expected: success.

- [ ] **Step 3: Verify with Playwright MCP** — canned walkthrough drives without errors even with placeholder renderers:
- `browser_navigate` to `file:///C:/Code/luke/shazam/shazam-demo.html`
- `browser_click` the song `▶ Canned playback` button
- `browser_wait_for` the controls to appear (text "Next")
- `browser_evaluate`: click Next 5× and assert the tracker's active step advances to "6. matching" and `window`-level errors are absent (`browser_console_messages` shows no errors).

- [ ] **Step 4: Commit** — `git add src/controller.js && git commit -m "feat: stage controller, precompute, keyboard, live/canned modes"`

---

### Task 9: Renderers — Waveform, Fourier, Spectrogram

**Files:**
- Modify: `src/renderers.js` (add `waveform`, `fourier`, `spectrogram`)

**Interfaces:**
- Consumes: `stageData = { pcm, sr, spec, peaks, ... }`, `DSP` for the Fourier decomposition.
- Produces: `Renderers.waveform`, `Renderers.fourier`, `Renderers.spectrogram`, each `(ctx, data, progress, W, H)`.

- [ ] **Step 1: Add the three renderers to `src/renderers.js`** (inside the IIFE)

```js
  const AX = '#6a6a88', FG = '#4be0c0', HOT = ['#0a0a12','#1a1a4a','#4b2bff','#ff5bd0','#ffd24b','#ffffff'];
  function heat(v) { // v in 0..1 -> color
    const x = Math.max(0, Math.min(0.999, v)) * (HOT.length - 1);
    return HOT[Math.round(x)];
  }
  root.Renderers.waveform = (ctx, d, p, W, H) => {
    const pcm = d.pcm, n = pcm.length, mid = H / 2, show = Math.floor(n * p);
    ctx.strokeStyle = FG; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const i = Math.floor((x / W) * n); if (i > show) break;
      ctx.lineTo(x, mid + pcm[i] * mid * 0.9);
    }
    ctx.stroke();
    ctx.fillStyle = AX; ctx.font = '16px system-ui';
    ctx.fillText('amplitude (air pressure) →', 12, 22); ctx.fillText('time →', W - 70, H - 12);
  };
  root.Renderers.fourier = (ctx, d, p, W, H) => {
    // Left: the raw waveform slice we analyse. Right: its magnitude spectrum growing with p.
    const frame = 1024, start = Math.floor(d.pcm.length / 2), halfW = W / 2;
    const re = new Float64Array(frame), im = new Float64Array(frame), win = d.__hann || (d.__hann = D.hann(frame));
    // draw the time-domain slice on the left
    ctx.strokeStyle = FG; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let i = 0; i < frame; i++) {
      const s = d.pcm[start + i] || 0;
      ctx.lineTo((i / frame) * halfW, H / 2 + s * (H / 4));
    }
    ctx.stroke();
    // FFT the windowed slice for the spectrum on the right
    for (let i = 0; i < frame; i++) { re[i] = (d.pcm[start + i] || 0) * win[i]; im[i] = 0; }
    D.fft(re, im);
    const bins = frame / 2, mags = []; let max = 1e-9;
    for (let b = 0; b < bins; b++) { const m = Math.hypot(re[b], im[b]); mags.push(m); if (m > max) max = m; }
    const shown = Math.floor(bins * p);
    ctx.fillStyle = '#ff5bd0';
    for (let b = 0; b < shown; b++) {
      const x = halfW + (b / bins) * halfW, h = (mags[b] / max) * (H * 0.8);
      ctx.fillRect(x, H - h, Math.max(1, halfW / bins), h);
    }
    ctx.fillStyle = AX; ctx.font = '15px system-ui';
    ctx.fillText('one time-slice (waveform)', 12, 22);
    ctx.fillText('frequencies in that slice →', halfW + 12, 22);
  };
  root.Renderers.spectrogram = (ctx, d, p, W, H) => {
    const cols = d.spec.columns, nT = d.spec.numFrames, nB = d.spec.numBins;
    let max = d.__specMax; if (!max) { max = 1e-9; for (const c of cols) for (let b = 0; b < nB; b++) if (c[b] > max) max = c[b]; d.__specMax = max; }
    const shownT = Math.floor(nT * p), cw = W / nT, ch = H / nB;
    for (let t = 0; t < shownT; t++) {
      const c = cols[t];
      for (let b = 0; b < nB; b++) {
        const v = Math.log1p(c[b]) / Math.log1p(max);
        if (v < 0.06) continue;
        ctx.fillStyle = heat(v);
        ctx.fillRect(t * cw, H - (b + 1) * ch, cw + 1, ch + 1);
      }
    }
    ctx.fillStyle = AX; ctx.font = '15px system-ui';
    ctx.fillText('frequency ↑', 10, 20); ctx.fillText('time →', W - 60, H - 10);
  };
```

Note: the `fourier` waveform poly-line is intentionally simple; polish in Task 11 may refine visuals, but this renders a real slice + its real spectrum.

- [ ] **Step 2: Build** — Run: `npm run build`.

- [ ] **Step 3: Verify with Playwright MCP + screenshots**
- `browser_navigate` to the file, click canned playback, wait for controls.
- `browser_take_screenshot` on stage 1 (waveform). Press Next, screenshot stage 2 (fourier), Next, screenshot stage 3 (spectrogram).
- Confirm each screenshot shows the expected visual (waveform line; spectrum bars; time×frequency heatmap) and console has no errors.

- [ ] **Step 4: Commit** — `git add src/renderers.js && git commit -m "feat: waveform, fourier, spectrogram renderers"`

---

### Task 10: Renderers — Peaks, Fingerprints, Matching reveal

**Files:**
- Modify: `src/renderers.js` (add `peaks`, `fingerprints`, `matching`)

**Interfaces:**
- Consumes: `stageData.{ spec, peaks, fingerprints, results, songs, matchedSong }`.
- Produces: `Renderers.peaks`, `Renderers.fingerprints`, `Renderers.matching`.

- [ ] **Step 1: Add the three renderers to `src/renderers.js`**

```js
  const px = (t, nT, W) => (t / nT) * W;
  const py = (f, nB, H) => H - (f / nB) * H;
  root.Renderers.peaks = (ctx, d, p, W, H) => {
    const nT = d.spec.numFrames, nB = d.spec.numBins;
    // faint spectrogram fading out, constellation fading in
    ctx.globalAlpha = 0.25 * (1 - p);
    root.Renderers.spectrogram(ctx, d, 1, W, H);
    ctx.globalAlpha = 1;
    const shown = Math.floor(d.peaks.length * p);
    ctx.fillStyle = '#ffd24b';
    for (let i = 0; i < shown; i++) {
      const pk = d.peaks[i];
      ctx.beginPath(); ctx.arc(px(pk.t, nT, W), py(pk.f, nB, H), 3, 0, 7); ctx.fill();
    }
    ctx.fillStyle = AX; ctx.font = '15px system-ui';
    ctx.fillText('constellation map (strongest peaks)', 12, 22);
  };
  root.Renderers.fingerprints = (ctx, d, p, W, H) => {
    const nT = d.spec.numFrames, nB = d.spec.numBins;
    ctx.fillStyle = '#ffd24b';
    for (const pk of d.peaks) { ctx.beginPath(); ctx.arc(px(pk.t, nT, W), py(pk.f, nB, H), 2.5, 0, 7); ctx.fill(); }
    // animate pairing lines from a few anchors
    const anchors = d.peaks.filter((_, i) => i % 40 === 0).slice(0, 8);
    const reveal = Math.floor(anchors.length * p) + 1;
    ctx.strokeStyle = '#4be0c0'; ctx.lineWidth = 1.5;
    anchors.slice(0, reveal).forEach(a => {
      d.peaks.forEach(b => {
        const dt = b.t - a.t;
        if (dt >= D.CONFIG.targetZoneMinDt && dt <= D.CONFIG.targetZoneMaxDt && Math.abs(b.f - a.f) <= D.CONFIG.targetZoneFreqRange) {
          ctx.beginPath(); ctx.moveTo(px(a.t, nT, W), py(a.f, nB, H)); ctx.lineTo(px(b.t, nT, W), py(b.f, nB, H)); ctx.stroke();
        }
      });
    });
    ctx.fillStyle = '#e8e8f0'; ctx.font = '18px system-ui';
    if (d.fingerprints[0]) ctx.fillText(`(f₁, f₂, Δt) → hash 0x${(d.fingerprints[0].hash >>> 0).toString(16)}`, 12, H - 16);
    ctx.fillStyle = AX; ctx.font = '15px system-ui';
    ctx.fillText('pair peaks in a target zone → fingerprints', 12, 22);
  };
  root.Renderers.matching = (ctx, d, p, W, H) => {
    // scatter: x = time in recording, y = time in song, for the winning song (diagonal) + others (scatter)
    const best = d.results[0];
    ctx.fillStyle = AX; ctx.font = '15px system-ui';
    ctx.fillText('time in recording →', 12, H - 10);
    ctx.save(); ctx.translate(16, H / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('time in matched song →', 0, 0); ctx.restore();
    if (!best) { ctx.fillText('no match', W / 2, H / 2); return; }
    // Plot the aligned offset line for the winning song (the clean diagonal is the payoff visual).
    const off = best.offset, nT = d.spec.numFrames;
    const shown = Math.floor(nT * p);
    ctx.fillStyle = '#4be0c0';
    for (let tq = 0; tq < shown; tq++) {
      const x = (tq / nT) * (W - 120) + 60, y = H - 40 - (((tq + off) / (nT + Math.abs(off))) * (H - 100));
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill();
    }
    if (p >= 1 && d.matchedSong) {
      ctx.fillStyle = 'rgba(10,10,18,.82)'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#4be0c0'; ctx.font = 'bold 30px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('MATCH', W / 2, H / 2 - 40);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 40px system-ui';
      ctx.fillText(`${d.matchedSong.title}`, W / 2, H / 2 + 6);
      ctx.fillStyle = '#9a9ac8'; ctx.font = '24px system-ui';
      ctx.fillText(`${d.matchedSong.artist}   ·   ${best.score} votes`, W / 2, H / 2 + 48);
      ctx.textAlign = 'left';
    }
  };
```

Note: the matching scatter plots the aligned offset line for the winning song (the payoff visual is the clean diagonal + the reveal). Refinements to also scatter losing-song hits are optional polish, not required for the teaching point.

- [ ] **Step 2: Build** — Run: `npm run build`.

- [ ] **Step 3: Verify with Playwright MCP + screenshots**
- Navigate, canned playback, wait, press Next to each of stages 4/5/6, screenshotting each.
- Confirm: constellation of dots (stage 4), pairing lines + a hash string (stage 5), scatter → "MATCH: <title> / <artist> / N votes" reveal (stage 6). The revealed title/artist must equal the selected canned song.
- `browser_console_messages`: no errors.

- [ ] **Step 4: Commit** — `git add src/renderers.js && git commit -m "feat: peaks, fingerprints, matching-reveal renderers"`

---

### Task 11: Polish, error states, rehearsal notes

**Files:**
- Modify: `src/controller.js` (mic-denied + no-match handling), `src/styles.css` (fullscreen/projector polish)
- Create: `README.md`

**Interfaces:**
- Consumes: everything prior. No new exports.

- [ ] **Step 1: Add error handling to `src/controller.js`** — wrap the live-mode handler body so a denied/blocked mic shows a friendly message instead of a silent failure:

```js
    $('modeLive').onclick = withLoading(async () => {
      try {
        $('loading').firstChild.textContent = 'Listening… ';
        const pcm = await IO.captureMic(10, lvl => ($('loadPct').textContent = '▮'.repeat(Math.round(lvl * 20))));
        $('loading').firstChild.textContent = 'Analysing… ';
        await beginPipeline(pcm);
      } catch (err) {
        alert('Microphone unavailable (' + err.name + '). Use Chrome/Edge, allow mic access, or use Canned playback.');
        throw err;
      }
    });
```

And in `beginPipeline`, guard a no-match so stage 6 still renders gracefully (the `matching` renderer already handles `!best`; ensure `matchedSong` may be null without throwing — it already does).

- [ ] **Step 2: Verify no regressions with Playwright MCP** — repeat the canned end-to-end walkthrough (Task 10 Step 3) and confirm all six stages still render and the match reveal is correct.

- [ ] **Step 3: Write `README.md`**

```markdown
# How Shazam Works — Live Demo

A single self-contained HTML file that walks through Shazam's recognition pipeline
and matches a song (live mic or canned clip) against 5 embedded tracks.

## Build
1. Put 5 MP3s in `./songs/`, named `Artist - Song title.mp3`.
2. `npm run build` → produces `shazam-demo.html`.

## Run the demo
- Double-click `shazam-demo.html` (opens in your browser, fully offline).
- **Use Chrome or Edge for the live-mic path** (Safari often blocks mic on file://).
- Wait a few seconds on first open while the 5 songs are analysed.
- **Canned playback:** pick a song, click ▶. **Live:** click 🎤, play the song into the mic for 10s.
- Space / → = next stage, ← = previous, R = replay animation, ⛶ = fullscreen.

## Rehearsal checklist
- [ ] Grant mic permission once in the presentation browser.
- [ ] Confirm a live recording of a DB song lands the correct match.
- [ ] Have canned playback ready as the fallback.

## Test the DSP core
`npm test`

## Swap songs
Replace files in `./songs/`, re-run `npm run build`.
```

- [ ] **Step 4: Run the DSP tests one final time** — Run: `npm test`. Expected: all tests PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: error handling, projector polish, README rehearsal notes"`

---

## Verification (end-to-end)

- **DSP correctness:** `npm test` — all unit tests pass (FFT, STFT, peaks, fingerprint determinism, end-to-end synthetic match).
- **Build:** `npm run build` produces `shazam-demo.html` (~30–35 MB) reporting 5 songs.
- **Self-test:** open `shazam-demo.html?selftest`, run `await window.__selfTest()` → top match equals the source song, score ≥ `minScore`.
- **Canned walkthrough (Playwright MCP):** open the file, canned playback, step through all 6 stages via spacebar; final reveal names the selected song; no console errors; screenshots of each stage look correct.
- **Live path (manual rehearsal, Chrome/Edge):** grant mic, play a DB song for 10s, confirm the correct match reveal.
- **Offline check:** disconnect from the network and confirm the file still opens and runs fully.

## Self-Review notes

- **Spec coverage:** all six pipeline stages (Tasks 9–10), live + canned inputs (Tasks 6, 8), 5-song embedded DB + filename metadata (Task 7 build), precompute-then-replay (Task 8), single self-contained offline file (Task 7 template + build), no external libraries (all tasks use only built-ins), pure-DSP Node tests (Tasks 1–5), projector UX + fullscreen + rehearsal notes (Tasks 7, 11), Chrome/Edge-for-live guidance (README + error handling). Covered.
- **Type consistency:** `stageData` field names (`pcm, sr, spec, peaks, fingerprints, results, songs, matchedSong`) are consistent across controller (Task 8) and renderers (Tasks 9–10). `matchQuery` returns `{songId, score, offset}` used identically in controller and the matching renderer. `spec` shape `{columns, numFrames, numBins}` consistent from Task 2 onward.
- **Tunable params:** peak/target-zone/`minScore` constants live in one `CONFIG` (Task 1) and may need rehearsal tuning against the real songs; noted in Global Constraints.
