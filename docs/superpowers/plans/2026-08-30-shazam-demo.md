# Shazam Pipeline Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single self-contained `.html` file that visually walks an audience through Shazam's 6-stage recognition pipeline and performs a real match (live mic or canned clip) against a small local database of embedded full songs, plus a standalone documentation page.

**Architecture:** Pure-JS DSP core (FFT → spectrogram → peaks → fingerprint hashing → offset-vote matching) that runs in both Node (tests) and the browser/worker. A browser audio layer decodes embedded MP3s and does streaming mic capture. A Web Worker (built from an embedded Blob) fingerprints songs in the background at load. A stage controller precomputes everything off the critical path, then drives six canvas renderers with the spacebar. A Node build script bakes all code + base64-encoded full songs into one deliverable HTML file. A separate hand-written HTML page documents the concepts, code, and run steps.

**Tech Stack:** Vanilla JavaScript, HTML Canvas 2D, Web Audio API, Web Worker, Node 18+ (build + `node:test`). No third-party libraries anywhere.

## Global Constraints

- **Single self-contained deliverable:** output is one `shazam-demo.html`, opened by double-click (`file://`), fully offline. No servers, no network, no CDN. The docs page (`docs/how-it-works.html`) is a second self-contained offline HTML file, not needed to run the demo.
- **No external libraries** — including the FFT; everything is hand-written vanilla JS.
- **Readable, commented code** — every source file starts with a short header comment stating its responsibility; non-obvious logic is commented. A presenter should be able to read the code alongside the docs page and follow it.
- **Cross-platform:** must open on Windows and Mac. Live mic recommended in Chrome/Edge (Safari often blocks `getUserMedia` on `file://`); canned works everywhere.
- **Dual-runtime DSP:** `src/dsp.js` uses the CommonJS-or-global wrapper so the same source runs under `node --test`, as a browser `<script>`, and inside the Web Worker (`self`).
- **Background precompute, then replay:** song fingerprinting runs in a Web Worker starting at page load; the recording's per-stage artifacts are precomputed before stepping. Nothing heavy runs on Next.
- **Songs:** full MP3s in `./songs/` (git-ignored), named `Artist - Song title.mp3`; metadata parsed from filename. Full songs embedded so live can match any section. Sweet spot ~5–10 songs; the build accepts any count and prints/warns on output size.
- **DSP config (shared constants, defined once in `src/dsp.js`):** `sampleRate: 11025`, `frameSize: 1024`, `hopSize: 512`, `peakNeighborhoodTime: 3`, `peakNeighborhoodFreq: 3`, `peaksPerFrameCap: 5`, `targetZoneMinDt: 1`, `targetZoneMaxDt: 63`, `targetZoneFreqRange: 200`, `fanout: 8`, `minScore: 5`. Tunable during rehearsal.
- **Shared `stageData` shape** (produced by the controller, consumed by all renderers):
  `{ pcm: Float32Array, sr: number, spec: {columns, numFrames, numBins}, peaks: [{t,f,mag}], fingerprints: [{hash,t}], results: [{songId,score,offset}], songs: [...], matchedSong: {id,artist,title}|null, focusFrame: number }`
  `focusFrame` is the frame index of the short slice that Stage 2 analyses and Stage 3 stacks first (visual continuity).

## File Structure

- `package.json` — test/build scripts only, no dependencies, `"type": "commonjs"`.
- `src/dsp.js` — DSP core, dual-runtime. Exports `{ CONFIG, fft, hann, stft, findPeaks, fingerprint, buildDatabase, matchQuery }`.
- `src/worker.js` — Web Worker message handler; calls `self.DSP` to fingerprint a transferred PCM buffer.
- `src/audio.js` — browser audio: `AudioIO.{ decodeToMono, base64ToArrayBuffer, sliceSeconds, captureMicStreaming, resampleLinear, makeSource }`.
- `src/renderers.js` — six stage renderers under `Renderers.{ waveform, fourier, spectrogram, peaks, fingerprints, matching }`.
- `src/controller.js` — app state machine, worker orchestration, background precompute, keyboard, modes, self-test hook.
- `src/styles.css` — dark projector theme.
- `src/template.html` — HTML shell with `/*__STYLES__*/`, `/*__SONGS__*/`, `/*__WORKER__*/`, `/*__SCRIPT__*/` placeholders.
- `build.mjs` — Node build: reads `./songs/*.mp3`, parses metadata, base64-embeds full songs, inlines all `src` files (+ worker source string) into `shazam-demo.html`.
- `test/*.test.js`, `test/helpers.js` — Node unit tests + synthetic-PCM generators for the DSP core.
- `docs/how-it-works.html` — standalone documentation page.
- `README.md` — run/rehearsal notes.

---

### Task 1: Scaffold + FFT

**Files:**
- Create: `package.json`, `src/dsp.js`, `test/dsp-fft.test.js`

**Interfaces:**
- Produces: `require('../src/dsp.js')` → `{ CONFIG, fft }`. `fft(re, im)` mutates two equal-length `Float64Array`s (length a power of 2) in place into the DFT (real and imaginary parts).

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
// dsp.js — pure DSP core for the Shazam demo.
// Runs unchanged in Node (tests), the browser (<script>), and the Web Worker (self).
// No DOM, no Web Audio, no dependencies — just math on Float arrays.
(function (root) {
  // Tunable pipeline constants. Frames are ~93 ms at 11025 Hz; hop = 50% overlap.
  const CONFIG = {
    sampleRate: 11025, frameSize: 1024, hopSize: 512,
    peakNeighborhoodTime: 3, peakNeighborhoodFreq: 3, peaksPerFrameCap: 5,
    targetZoneMinDt: 1, targetZoneMaxDt: 63, targetZoneFreqRange: 200,
    fanout: 8, minScore: 5,
  };

  // In-place iterative radix-2 Cooley–Tukey FFT. re/im are mutated to hold the transform.
  function fft(re, im) {
    const n = re.length;
    // bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let tr = re[i]; re[i] = re[j]; re[j] = tr;
        let ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    // butterflies
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
- Modify: `src/dsp.js` (add `hann`, `stft`)
- Create: `test/dsp-stft.test.js`, `test/helpers.js`

**Interfaces:**
- Consumes: `fft`, `CONFIG`.
- Produces: `hann(n) -> Float64Array`. `stft(pcm, cfg=CONFIG) -> { columns: Float32Array[], numFrames, numBins }`, each column = `frameSize/2` magnitudes. `test/helpers.js` exports `tone(freq, seconds, sr)`.

- [ ] **Step 1: Write `test/helpers.js`**

```js
const { CONFIG } = require('../src/dsp.js');
// Generate a pure sine tone as Float32 PCM.
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
```

- [ ] **Step 3: Run test to verify it fails** — Run: `npm test`. Expected: FAIL (`stft is not a function`).

- [ ] **Step 4: Add implementation to `src/dsp.js`** (inside the IIFE, before the `DSP` object)

```js
  // Hann window reduces spectral leakage before the FFT.
  function hann(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    return w;
  }
  // Short-Time Fourier Transform: slide a windowed FFT across the signal.
  // Returns one magnitude column per frame -> the spectrogram.
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

Extend export: `const DSP = { CONFIG, fft, hann, stft };`

- [ ] **Step 5: Run test to verify it passes** — Run: `npm test`. Expected: PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: Hann window + STFT spectrogram"`

---

### Task 3: Peak detection

**Files:**
- Modify: `src/dsp.js` (add `findPeaks`)
- Create: `test/dsp-peaks.test.js`

**Interfaces:**
- Consumes: `stft` output, `CONFIG`.
- Produces: `findPeaks(spec, cfg=CONFIG) -> Array<{ t, f, mag }>` (t = frame index, f = bin index), local maxima in a time×frequency neighborhood, capped at `peaksPerFrameCap` strongest per frame.

- [ ] **Step 1: Write the failing test** — `test/dsp-peaks.test.js`

```js
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
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npm test`. Expected: FAIL (`findPeaks is not a function`).

- [ ] **Step 3: Add implementation to `src/dsp.js`**

```js
  // Keep only points that are a local maximum within a time x frequency neighborhood,
  // then keep the strongest few per frame. These sparse peaks survive noise and EQ changes.
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

Extend export: add `findPeaks`.

- [ ] **Step 4: Run test to verify it passes** — Run: `npm test`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: local-maximum peak detection"`

---

### Task 4: Fingerprint hashing

**Files:**
- Modify: `src/dsp.js` (add `fingerprint`)
- Create: `test/dsp-fingerprint.test.js`

**Interfaces:**
- Consumes: peak list, `CONFIG`.
- Produces: `fingerprint(peaks, cfg=CONFIG) -> Array<{ hash, t }>`; `hash` = unsigned 32-bit int packing `(f1<<23)|(f2<<14)|dt`; `t` = anchor frame. Deterministic.

- [ ] **Step 1: Write the failing test** — `test/dsp-fingerprint.test.js`

```js
const test = require('node:test');
const assert = require('node:assert');
const { fingerprint } = require('../src/dsp.js');

const peaks = [{ t: 0, f: 10, mag: 1 }, { t: 3, f: 20, mag: 1 }, { t: 5, f: 15, mag: 1 }];

test('fingerprint is deterministic and produces valid uint32 hashes', () => {
  const a = fingerprint(peaks), b = fingerprint(peaks);
  assert.deepStrictEqual(a, b);
  assert.ok(a.length > 0);
  assert.ok(a.every(fp => Number.isInteger(fp.hash) && fp.hash >= 0 && fp.hash <= 0xFFFFFFFF));
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npm test`. Expected: FAIL (`fingerprint is not a function`).

- [ ] **Step 3: Add implementation to `src/dsp.js`**

```js
  // Pair each anchor peak with later peaks in a "target zone". Each pair (f1, f2, dt)
  // packs into a 32-bit hash — a compact, distortion-tolerant fingerprint of the audio.
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
- Produces:
  - `buildDatabase(perSong) -> Map<hash, Array<{songId, t}>>`; `perSong` = `Array<{ songId, fingerprints }>`.
  - `matchQuery(queryFps, db, cfg=CONFIG) -> Array<{ songId, score, offset }>` sorted by `score` desc (score = votes in the best time-offset bin).
  - `sequence(notes, sr)` in helpers: concatenate `Array<{ freq, seconds }>` into one `Float32Array`.

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
```

- [ ] **Step 3: Run test to verify it fails** — Run: `npm test`. Expected: FAIL (`buildDatabase is not a function`).

- [ ] **Step 4: Add implementation to `src/dsp.js`**

```js
  // Index every fingerprint by its hash: hash -> list of (songId, anchor time).
  function buildDatabase(perSong) {
    const db = new Map();
    for (const { songId, fingerprints } of perSong)
      for (const { hash, t } of fingerprints) {
        let arr = db.get(hash); if (!arr) { arr = []; db.set(hash, arr); }
        arr.push({ songId, t });
      }
    return db;
  }
  // For each query hash, every DB hit votes for (song, time-offset). The correct song
  // accumulates many votes at ONE consistent offset; noise scatters across offsets.
  function matchQuery(queryFps, db, cfg = CONFIG) {
    const votes = new Map(); // songId -> Map(offset -> count)
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

### Task 6: Browser audio layer (decode, slice, streaming mic, playback)

**Files:**
- Create: `src/audio.js`

**Interfaces:**
- Consumes: global `DSP.CONFIG`.
- Produces global `AudioIO`:
  - `base64ToArrayBuffer(b64) -> ArrayBuffer`
  - `decodeToMono(arrayBuffer) -> Promise<Float32Array>` at `DSP.CONFIG.sampleRate`, mono.
  - `sliceSeconds(pcm, startSec, durSec, sr?) -> Float32Array`
  - `resampleLinear(buf, fromRate, toRate) -> Float32Array`
  - `captureMicStreaming(seconds, onChunk, onLevel) -> Promise<Float32Array>` — records from mic; calls `onChunk(Float32Array)` per audio block (for the real-time Stage-1 waveform) and `onLevel(0..1)`; returns the full recording resampled to `DSP.CONFIG.sampleRate`.
  - `makeSource(pcm, sr?) -> { play(), stop() }` — plays a Float32Array for Stage-1 audio.

Browser-only; verified in later tasks via the browser.

- [ ] **Step 1: Write `src/audio.js`**

```js
// audio.js — browser audio I/O for the demo (decode, slice, resample, mic capture, playback).
// Web Audio is main-thread only, so all of this lives here (not in the worker).
(function (root) {
  const SR = () => root.DSP.CONFIG.sampleRate;

  function base64ToArrayBuffer(b64) {
    const bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // Simple linear resampler (good enough for fingerprinting; robust to small artifacts).
  function resampleLinear(buf, fromRate, toRate) {
    if (fromRate === toRate) return buf;
    const ratio = toRate / fromRate, outLen = Math.round(buf.length * ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = i / ratio, i0 = Math.floor(src), i1 = Math.min(buf.length - 1, i0 + 1);
      out[i] = buf[i0] + (buf[i1] - buf[i0]) * (src - i0);
    }
    return out;
  }

  // Decode compressed audio -> mono Float32 at the DSP sample rate.
  async function decodeToMono(arrayBuffer) {
    const Ctx = root.AudioContext || root.webkitAudioContext;
    const tmp = new Ctx();
    const decoded = await tmp.decodeAudioData(arrayBuffer.slice(0));
    tmp.close();
    // Render through an offline context at the target rate to downmix + resample in one pass.
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

  // Record from the mic, streaming blocks to onChunk for live drawing. Resolves with the
  // full recording resampled to the DSP rate.
  async function captureMicStreaming(seconds, onChunk, onLevel) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const Ctx = root.AudioContext || root.webkitAudioContext;
    let ac; try { ac = new Ctx({ sampleRate: SR() }); } catch (e) { ac = new Ctx(); }
    const src = ac.createMediaStreamSource(stream);
    const proc = ac.createScriptProcessor(2048, 1, 1);
    const mute = ac.createGain(); mute.gain.value = 0; // process without echoing mic to speakers
    const chunks = [];
    proc.onaudioprocess = e => {
      const data = e.inputBuffer.getChannelData(0), copy = new Float32Array(data);
      chunks.push(copy);
      if (onChunk) onChunk(copy);
      if (onLevel) { let pk = 0; for (let i = 0; i < copy.length; i++) pk = Math.max(pk, Math.abs(copy[i])); onLevel(pk); }
    };
    src.connect(proc); proc.connect(mute); mute.connect(ac.destination);
    await new Promise(r => setTimeout(r, seconds * 1000));
    proc.disconnect(); src.disconnect(); stream.getTracks().forEach(t => t.stop());
    const rate = ac.sampleRate; ac.close();
    // concatenate captured blocks
    const total = chunks.reduce((s, c) => s + c.length, 0), full = new Float32Array(total);
    let o = 0; for (const c of chunks) { full.set(c, o); o += c.length; }
    return resampleLinear(full, rate, SR());
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

  root.AudioIO = { base64ToArrayBuffer, decodeToMono, sliceSeconds, resampleLinear, captureMicStreaming, makeSource };
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 2: Commit** — `git add src/audio.js && git commit -m "feat: browser audio layer with streaming mic capture"`

---

### Task 7: Fingerprint Web Worker

**Files:**
- Create: `src/worker.js`

**Interfaces:**
- Consumes (inside the worker): `self.DSP` (the `dsp.js` source is prepended to this handler by the build to form the worker script).
- Produces: a worker that, on `postMessage({ id, pcm })` (pcm = transferred `Float32Array`), replies `postMessage({ id, fingerprints })`. The controller (Task 9) turns `src/dsp.js` + `src/worker.js` into a Blob worker at runtime via the embedded `WORKER_SOURCE` string (Task 8 build).

- [ ] **Step 1: Write `src/worker.js`**

```js
// worker.js — runs inside the Web Worker. dsp.js is prepended by the build, so self.DSP exists.
// Fingerprinting (many FFTs) is CPU-heavy; doing it here keeps the UI responsive.
self.onmessage = function (e) {
  const { id, pcm } = e.data;
  const D = self.DSP;
  const fingerprints = D.fingerprint(D.findPeaks(D.stft(pcm)));
  self.postMessage({ id, fingerprints });
};
```

- [ ] **Step 2: Commit** — `git add src/worker.js && git commit -m "feat: fingerprint web worker handler"`

---

### Task 8: Build script + HTML shell + self-test hook

**Files:**
- Create: `build.mjs`, `src/template.html`, `src/styles.css`, `src/renderers.js` (placeholder), `src/controller.js` (minimal loader + self-test)

**Interfaces:**
- Consumes: `./songs/*.mp3`, all `src/*` files.
- Produces: `shazam-demo.html` at repo root. Injects `WORKER_SOURCE` = `dsp.js` + `worker.js` (as a JS string) so the controller can spawn the worker offline. Exposes `window.__selfTest()` under `?selftest`, returning `Promise<{ songs, topSongId, expected, topScore }>`.

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
button:disabled { opacity: .5; cursor: default; }
button.secondary { background: #23233a; }
#start { position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 22px; background: #0a0a12; z-index: 10; }
#start h1 { font-size: 42px; } #start .modes { display: flex; gap: 20px; align-items: center; }
#status { color: #9a9ac8; font-size: 16px; min-height: 22px; }
#loading { position: absolute; inset: 0; display: none; align-items: center;
  justify-content: center; font-size: 24px; background: rgba(10,10,18,.9); z-index: 20; }
select { font-size: 18px; padding: 10px; border-radius: 8px; }
.hidden { display: none !important; }
```

- [ ] **Step 2: Write `src/renderers.js`** (placeholder, filled in Tasks 10–11)

```js
// renderers.js — one canvas renderer per pipeline stage. Filled in Tasks 10-11.
(function (root) { root.Renderers = {}; })(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 3: Write minimal `src/controller.js`** (DB loader + self-test; extended in Task 9)

```js
// controller.js — orchestrates the demo. This minimal version loads the song database
// (via the worker) and exposes a self-test; the full UI/state machine is added in Task 9.
(function (root) {
  const D = root.DSP, IO = root.AudioIO;

  // Spawn the fingerprint worker from the embedded source (works offline on file://).
  function makeWorker() {
    const blob = new Blob([root.WORKER_SOURCE], { type: 'text/javascript' });
    return new Worker(URL.createObjectURL(blob));
  }

  // Decode each song on the main thread, fingerprint it in the worker, and build the DB.
  async function loadDatabase(songs, onProgress) {
    const worker = makeWorker();
    const perSong = [];
    for (let i = 0; i < songs.length; i++) {
      const s = songs[i];
      s._pcm = await IO.decodeToMono(IO.base64ToArrayBuffer(s.data));
      const fingerprints = await new Promise(res => {
        worker.onmessage = e => res(e.data.fingerprints);
        const copy = s._pcm.slice();               // keep our pcm; transfer a copy
        worker.postMessage({ id: s.id, pcm: copy }, [copy.buffer]);
      });
      perSong.push({ songId: s.id, fingerprints });
      if (onProgress) onProgress(Math.round(((i + 1) / songs.length) * 100));
    }
    worker.terminate();
    return D.buildDatabase(perSong);
  }
  root.App = { loadDatabase, makeWorker };

  if (typeof location !== 'undefined' && location.search.includes('selftest')) {
    root.__selfTest = async () => {
      const db = await loadDatabase(root.SONGS);
      const first = root.SONGS[0];
      const clip = IO.sliceSeconds(first._pcm, 10, 6);
      const res = D.matchQuery(D.fingerprint(D.findPeaks(D.stft(clip))), db);
      return { songs: root.SONGS.length, topSongId: res[0] && res[0].songId, expected: first.id, topScore: res[0] && res[0].score };
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
      <div id="status">Preparing song database…</div>
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
<script>/*__WORKER__*/</script>
<script>/*__SCRIPT__*/</script>
</body>
</html>
```

- [ ] **Step 5: Write `build.mjs`**

```js
// build.mjs — bakes all source + the songs into one self-contained shazam-demo.html.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SONGS_DIR = 'songs';
const files = readdirSync(SONGS_DIR).filter(f => f.toLowerCase().endsWith('.mp3')).sort();
if (files.length === 0) throw new Error('No .mp3 files in ./songs');

// Parse "Artist - Title.mp3" and base64-encode the full song.
const songs = files.map((f, i) => {
  const base = f.replace(/\.mp3$/i, ''), parts = base.split(' - ');
  const artist = parts.length > 1 ? parts[0].trim() : 'Unknown';
  const title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : base;
  return { id: 's' + i, artist, title, mime: 'audio/mpeg',
    data: readFileSync(join(SONGS_DIR, f)).toString('base64') };
});

const read = p => readFileSync(p, 'utf8');
// The worker script = dsp.js (defines self.DSP) + worker.js handler, embedded as a JS string.
const workerSource = read('src/dsp.js') + '\n' + read('src/worker.js');
const bundle = [read('src/dsp.js'), read('src/audio.js'), read('src/renderers.js'), read('src/controller.js')].join('\n\n');

const html = read('src/template.html')
  .replace('/*__STYLES__*/', () => read('src/styles.css'))
  .replace('/*__SONGS__*/', () => 'const SONGS=' + JSON.stringify(songs) + ';')
  .replace('/*__WORKER__*/', () => 'const WORKER_SOURCE=' + JSON.stringify(workerSource) + ';')
  .replace('/*__SCRIPT__*/', () => bundle);

writeFileSync('shazam-demo.html', html);
const mb = (Buffer.byteLength(html) / 1048576).toFixed(1);
console.log(`Built shazam-demo.html — ${songs.length} songs, ${mb} MB`);
if (mb > 60) console.warn(`WARNING: ${mb} MB is large; consider fewer songs for faster load.`);
```

Note: `.replace(pattern, () => text)` uses replacer functions so `$` in embedded content is literal.

- [ ] **Step 6: Build and verify with Playwright MCP**

Run: `npm run build`. Expected: prints song count + size.
Then verify the self-test:
- `browser_navigate` to `file:///C:/Code/luke/shazam/shazam-demo.html?selftest`
- `browser_evaluate`: `async () => await window.__selfTest()`
- Expected: `{ songs: N, topSongId === expected, topScore >= 5 }` (the clip's source song wins).

- [ ] **Step 7: Commit** — `git add build.mjs src/template.html src/styles.css src/renderers.js src/controller.js && git commit -m "feat: build script, HTML shell, worker-backed DB loader + self-test"`

---

### Task 9: Stage controller (background precompute, live streaming, modes, keyboard)

**Files:**
- Modify: `src/controller.js` (extend the minimal version into the full controller)

**Interfaces:**
- Consumes: `DSP`, `AudioIO`, `Renderers`, `SONGS`, `WORKER_SOURCE`, DOM ids.
- Produces the running app. Kicks off `loadDatabase` in the background at load; builds `stageData` (see Global Constraints) for canned/live; live Stage 1 draws in real time; Stages 2–6 precomputed before stepping.

- [ ] **Step 1: Add the controller body to `src/controller.js`** (inside the IIFE, after the minimal loader)

```js
  const STAGES = [
    ['waveform',     'A microphone records the song as a waveform — air pressure over time.'],
    ['fourier',      'Zoom into a short slice: the Fourier transform splits it into sine waves.'],
    ['spectrogram',  'Stack each slice’s frequencies over time to form a spectrogram.'],
    ['peaks',        'Keep only the strongest peaks — a constellation that survives noise.'],
    ['fingerprints', 'Pair peaks into hashes: (f₁, f₂, Δt) → a 32-bit fingerprint.'],
    ['matching',     'Votes for the same song at the same time-offset reveal the match.'],
  ];
  const $ = id => document.getElementById(id);
  let canvas, ctx, stageData = null, db = null, dbReady = null, stageIdx = 0, anim = null;

  function resize() {
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width * devicePixelRatio; canvas.height = r.height * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    if (stageData) draw(1);
  }
  const dims = () => [canvas.width / devicePixelRatio, canvas.height / devicePixelRatio];

  function renderTracker() {
    $('tracker').innerHTML = STAGES.map((s, i) =>
      `<div class="step ${i === stageIdx ? 'active' : i < stageIdx ? 'done' : ''}">${i + 1}. ${s[0]}</div>`).join('');
  }
  function draw(progress) {
    const [W, H] = dims(); ctx.clearRect(0, 0, W, H);
    (root.Renderers[STAGES[stageIdx][0]] || (() => {}))(ctx, stageData, progress, W, H);
  }
  function animateStage() {
    cancelAnimationFrame(anim);
    const DUR = 2200, start = performance.now();
    const tick = now => {
      const p = Math.min(1, (now - start) / DUR);
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

  // Compute every artifact a renderer needs for the given recording PCM, up front.
  function precompute(pcm) {
    const spec = D.stft(pcm), peaks = D.findPeaks(spec), fps = D.fingerprint(peaks);
    const results = D.matchQuery(fps, db);
    const matchedSong = root.SONGS.find(s => s.id === (results[0] && results[0].songId)) || null;
    const focusFrame = Math.max(0, Math.floor(spec.numFrames / 2)); // slice Stage 2/3 share
    stageData = { pcm, sr: D.CONFIG.sampleRate, spec, peaks, fingerprints: fps, results, songs: root.SONGS, matchedSong, focusFrame };
  }
  function enterPipeline() {
    $('start').classList.add('hidden'); $('controls').classList.remove('hidden');
    showStage(0);
  }

  // --- Live mode: draw the waveform in real time while recording ---
  async function runLive() {
    $('start').classList.add('hidden'); $('controls').classList.add('hidden');
    stageIdx = 0; renderTracker();
    $('caption').textContent = 'Listening… play the song now.';
    // Live visual buffer: draw raw mic samples as they arrive (shape only — no resampling).
    // Sized for the worst-case native mic rate so it never overflows during the 10 s capture.
    const live = new Float32Array(48000 * 11); let filled = 0;
    const onChunk = chunk => {
      for (let i = 0; i < chunk.length && filled < live.length; i++) live[filled++] = chunk[i];
      const [W, H] = dims(); ctx.clearRect(0, 0, W, H);
      root.Renderers.waveform(ctx, { pcm: live.subarray(0, filled) }, 1, W, H); // maps across full width
    };
    // captureMicStreaming returns the recording correctly resampled to the DSP rate.
    const pcm = await IO.captureMicStreaming(10, onChunk, null);
    $('caption').textContent = 'Analysing…';
    await dbReady;
    precompute(pcm);
    $('controls').classList.remove('hidden');
    showStage(0);
  }

  async function runCanned() {
    await dbReady;
    const s = root.SONGS.find(x => x.id === $('songSelect').value) || root.SONGS[0];
    precompute(IO.sliceSeconds(s._pcm, 30, 10));
    enterPipeline();
  }

  function initUI() {
    canvas = $('stageCanvas'); ctx = canvas.getContext('2d');
    root.SONGS.forEach(s => {
      const o = document.createElement('option'); o.value = s.id;
      o.textContent = `${s.artist} — ${s.title}`; $('songSelect').appendChild(o);
    });
    renderTracker();
    // Start building the DB immediately, in the background, so it is ready by demo time.
    $('modeLive').disabled = $('modeCanned').disabled = true;
    dbReady = root.App.loadDatabase(root.SONGS, () => {})
      .then(d => { db = d; $('status').textContent = 'Ready ✓'; $('modeLive').disabled = $('modeCanned').disabled = false; })
      .catch(err => { $('status').textContent = 'Database error: ' + err.message; });

    $('modeCanned').onclick = () => runCanned();
    $('modeLive').onclick = () => runLive().catch(err =>
      alert('Microphone unavailable (' + err.name + '). Use Chrome/Edge, allow mic access, or use Canned playback.'));
    $('fsBtn').onclick = () => document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    $('nextBtn').onclick = () => showStage(stageIdx + 1);
    $('prevBtn').onclick = () => showStage(stageIdx - 1);
    $('replayBtn').onclick = () => animateStage();
    document.addEventListener('keydown', e => {
      if (!$('start').classList.contains('hidden')) return; // ignore keys on start screen
      if (e.code === 'Space' || e.code === 'ArrowRight') { e.preventDefault(); showStage(stageIdx + 1); }
      else if (e.code === 'ArrowLeft') showStage(stageIdx - 1);
      else if (e.key.toLowerCase() === 'r') animateStage();
    });
    window.addEventListener('resize', resize);
    resize();
  }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initUI);
```

Note: the live `onChunk` draws raw mic samples for the Stage-1 visual (waveform shape only, mapped across the full canvas width regardless of the mic's native rate). The recording that is actually fingerprinted/matched is the return value of `captureMicStreaming`, which is correctly resampled to the DSP rate.

- [ ] **Step 2: Build** — Run: `npm run build`.

- [ ] **Step 3: Verify with Playwright MCP** (canned path drives even with placeholder renderers)
- `browser_navigate` to `file:///C:/Code/luke/shazam/shazam-demo.html`
- `browser_wait_for` text "Ready ✓" (background DB build finished)
- `browser_click` `▶ Canned playback`
- `browser_wait_for` the controls (text "Next")
- `browser_evaluate`: advance with 5 Next clicks; assert the active tracker step becomes "6. matching".
- `browser_console_messages`: no errors.

- [ ] **Step 4: Commit** — `git add src/controller.js && git commit -m "feat: controller with background DB, live streaming stage 1, modes"`

---

### Task 10: Renderers — Waveform, Fourier (sinusoids), Spectrogram (stacking)

**Files:**
- Modify: `src/renderers.js` (add `waveform`, `fourier`, `spectrogram`)

**Interfaces:**
- Consumes: `stageData`, `DSP`.
- Produces: `Renderers.waveform` (works for both a full clip and a growing live buffer), `Renderers.fourier` (short slice → top-K sine components, note #6), `Renderers.spectrogram` (stacks outward from `focusFrame`, note #7).

- [ ] **Step 1: Add the three renderers to `src/renderers.js`** (inside the IIFE)

```js
  const D = root.DSP;
  const AX = '#6a6a88', FG = '#4be0c0';
  const HOT = ['#0a0a12', '#1a1a4a', '#4b2bff', '#ff5bd0', '#ffd24b', '#ffffff'];
  const heat = v => HOT[Math.round(Math.max(0, Math.min(0.999, v)) * (HOT.length - 1))];
  const COMP_COLORS = ['#4be0c0', '#ff5bd0', '#ffd24b', '#7b8cff', '#ff8a5b'];

  // Stage 1: air pressure over time. Draws d.pcm up to `p` (canned) or the whole buffer (live).
  root.Renderers.waveform = (ctx, d, p, W, H) => {
    const pcm = d.pcm, n = pcm.length, mid = H / 2, show = Math.floor(n * p);
    ctx.strokeStyle = FG; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const i = Math.floor((x / W) * n); if (i > show) break;
      ctx.lineTo(x, mid + (pcm[i] || 0) * mid * 0.9);
    }
    ctx.stroke();
    ctx.fillStyle = AX; ctx.font = '16px system-ui';
    ctx.fillText('amplitude (air pressure) →', 12, 22);
    ctx.fillText('time →', W - 70, H - 12);
  };

  // Stage 2 (note #6): a ~tens-of-ms slice decomposing into its strongest sine components.
  root.Renderers.fourier = (ctx, d, p, W, H) => {
    const frame = D.CONFIG.frameSize, sr = d.sr, start = d.focusFrame * D.CONFIG.hopSize;
    const pad = 40, topH = H * 0.34;
    // the raw short slice on top
    ctx.strokeStyle = FG; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < frame; i++) {
      const x = pad + (i / frame) * (W - 2 * pad), y = topH / 2 + (d.pcm[start + i] || 0) * (topH / 2) * 0.9;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = AX; ctx.font = '15px system-ui';
    ctx.fillText(`a ~${Math.round(frame / sr * 1000)} ms slice of the waveform`, pad, 20);
    ctx.fillText('= a sum of sine waves:', pad, topH + 22);
    // FFT the windowed slice, pick the strongest few components
    const win = D.hann(frame), re = new Float64Array(frame), im = new Float64Array(frame);
    for (let i = 0; i < frame; i++) { re[i] = (d.pcm[start + i] || 0) * win[i]; im[i] = 0; }
    D.fft(re, im);
    const bins = frame / 2, comps = [];
    for (let b = 1; b < bins; b++) comps.push({ b, mag: Math.hypot(re[b], im[b]), phase: Math.atan2(im[b], re[b]) });
    comps.sort((a, b) => b.mag - a.mag);
    const K = 5, top = comps.slice(0, K), maxMag = top[0] ? top[0].mag : 1;
    const shown = Math.max(1, Math.round(K * p)), rowH = (H - topH - 40) / K;
    for (let k = 0; k < shown; k++) {
      const c = top[k], f = c.b * sr / frame, amp = c.mag / maxMag, cy = topH + 40 + rowH * (k + 0.5);
      ctx.strokeStyle = COMP_COLORS[k % COMP_COLORS.length]; ctx.lineWidth = 1.5; ctx.beginPath();
      for (let xx = 0; xx <= W - 2 * pad; xx++) {
        const tt = (xx / (W - 2 * pad)) * (frame / sr);
        const y = cy + Math.sin(2 * Math.PI * f * tt + c.phase) * amp * (rowH * 0.4);
        xx ? ctx.lineTo(pad + xx, y) : ctx.moveTo(pad + xx, y);
      }
      ctx.stroke();
      ctx.fillStyle = AX; ctx.font = '13px system-ui';
      ctx.fillText(`${Math.round(f)} Hz`, W - pad - 62, cy - rowH * 0.28);
    }
  };

  // Stage 3 (note #7): reveal expands outward from the Stage-2 slice column so that single
  // FFT result is visibly "stacked" into the full time × frequency spectrogram.
  root.Renderers.spectrogram = (ctx, d, p, W, H) => {
    const cols = d.spec.columns, nT = d.spec.numFrames, nB = d.spec.numBins;
    let max = d.__specMax;
    if (!max) { max = 1e-9; for (const c of cols) for (let b = 0; b < nB; b++) if (c[b] > max) max = c[b]; d.__specMax = max; }
    const cw = W / nT, ch = H / nB, focus = d.focusFrame, reach = Math.round(nT * p);
    const lo = Math.max(0, focus - reach), hi = Math.min(nT - 1, focus + reach);
    for (let t = lo; t <= hi; t++) {
      const c = cols[t];
      for (let b = 0; b < nB; b++) {
        const v = Math.log1p(c[b]) / Math.log1p(max);
        if (v < 0.06) continue;
        ctx.fillStyle = heat(v); ctx.fillRect(t * cw, H - (b + 1) * ch, cw + 1, ch + 1);
      }
    }
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(focus * cw - 1, 0, cw + 2, H); // the Stage-2 slice
    ctx.fillStyle = AX; ctx.font = '15px system-ui';
    ctx.fillText('the slice from Stage 2 → one column; the rest stack in around it', 12, 20);
    ctx.fillText('frequency ↑', 10, H - 12); ctx.fillText('time →', W - 60, H - 12);
  };
```

- [ ] **Step 2: Build** — Run: `npm run build`.

- [ ] **Step 3: Verify with Playwright MCP + screenshots**
- Navigate, wait "Ready ✓", canned playback, wait controls.
- Screenshot stage 1 (waveform). Next → screenshot stage 2 (short slice + labelled sine rows in Hz). Next → screenshot stage 3 (heatmap with a highlighted focus column, reveal expanding outward).
- Confirm visuals + no console errors.

- [ ] **Step 4: Commit** — `git add src/renderers.js && git commit -m "feat: waveform, sinusoid-decomposition fourier, stacking spectrogram"`

---

### Task 11: Renderers — Peaks, Fingerprints, Matching reveal

**Files:**
- Modify: `src/renderers.js` (add `peaks`, `fingerprints`, `matching`)

**Interfaces:**
- Consumes: `stageData.{ spec, peaks, fingerprints, results, songs, matchedSong, focusFrame }`.
- Produces: `Renderers.peaks`, `Renderers.fingerprints`, `Renderers.matching`.

- [ ] **Step 1: Add the three renderers to `src/renderers.js`**

```js
  const px = (t, nT, W) => (t / nT) * W;
  const py = (f, nB, H) => H - (f / nB) * H;

  // Stage 4: fade the spectrogram out, fade the constellation of strongest peaks in.
  root.Renderers.peaks = (ctx, d, p, W, H) => {
    const nT = d.spec.numFrames, nB = d.spec.numBins;
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
    ctx.fillText('constellation map (strongest peaks only)', 12, 22);
  };

  // Stage 5: draw target-zone pairing lines from a few anchors, and show one packed hash.
  root.Renderers.fingerprints = (ctx, d, p, W, H) => {
    const nT = d.spec.numFrames, nB = d.spec.numBins;
    ctx.fillStyle = '#ffd24b';
    for (const pk of d.peaks) { ctx.beginPath(); ctx.arc(px(pk.t, nT, W), py(pk.f, nB, H), 2.5, 0, 7); ctx.fill(); }
    const anchors = d.peaks.filter((_, i) => i % 40 === 0).slice(0, 8);
    const reveal = Math.floor(anchors.length * p) + 1;
    ctx.strokeStyle = FG; ctx.lineWidth = 1.5;
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

  // Stage 6: plot the aligned offset line for the winning song, then reveal the match.
  root.Renderers.matching = (ctx, d, p, W, H) => {
    const best = d.results[0];
    ctx.fillStyle = AX; ctx.font = '15px system-ui';
    ctx.fillText('time in recording →', 12, H - 10);
    ctx.save(); ctx.translate(16, H / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('time in matched song →', 0, 0); ctx.restore();
    if (!best) { ctx.textAlign = 'center'; ctx.fillText('no confident match', W / 2, H / 2); ctx.textAlign = 'left'; return; }
    const off = best.offset, nT = d.spec.numFrames, shown = Math.floor(nT * p);
    ctx.fillStyle = FG;
    for (let tq = 0; tq < shown; tq++) {
      const x = (tq / nT) * (W - 120) + 60;
      const y = H - 40 - (((tq + off) / (nT + Math.abs(off))) * (H - 100));
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill();
    }
    if (p >= 1 && d.matchedSong) {
      ctx.fillStyle = 'rgba(10,10,18,.82)'; ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.fillStyle = FG; ctx.font = 'bold 30px system-ui'; ctx.fillText('MATCH', W / 2, H / 2 - 40);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 40px system-ui'; ctx.fillText(d.matchedSong.title, W / 2, H / 2 + 6);
      ctx.fillStyle = '#9a9ac8'; ctx.font = '24px system-ui';
      ctx.fillText(`${d.matchedSong.artist}   ·   ${best.score} votes`, W / 2, H / 2 + 48);
      ctx.textAlign = 'left';
    }
  };
```

- [ ] **Step 2: Build** — Run: `npm run build`.

- [ ] **Step 3: Verify with Playwright MCP + screenshots**
- Canned playback; Next to stages 4/5/6; screenshot each.
- Confirm: constellation dots (4), pairing lines + a hex hash (5), scatter → "MATCH: <title> / <artist> / N votes" reveal (6). The title/artist must equal the selected canned song. No console errors.

- [ ] **Step 4: Commit** — `git add src/renderers.js && git commit -m "feat: peaks, fingerprints, matching-reveal renderers"`

---

### Task 12: Standalone documentation page

**Files:**
- Create: `docs/how-it-works.html`

**Interfaces:**
- Self-contained (inline CSS), offline, no build step. Independent of the demo and slides.

- [ ] **Step 1: Write `docs/how-it-works.html`** — a single readable page with inline `<style>` and these sections, in a clean dark-on-light or light-on-dark theme with good typography and generous spacing:
  1. **What Shazam does** — the problem (brief noisy clip vs millions of songs), a line of history.
  2. **The pipeline at a glance** — the 6 stages listed with one sentence each.
  3. **Each stage explained** — one section per stage: Waveform, Fourier transform (with the coin-sorting analogy), Spectrogram, Peak detection / constellation, Fingerprints (the library/shelf analogy, and the `(f₁, f₂, Δt)` hash), Matching (offset voting).
  4. **How the code is organised** — a table mapping each `src/*.js` file to its responsibility and the key functions it exposes (`dsp.js`: `fft/stft/findPeaks/fingerprint/buildDatabase/matchQuery`; `audio.js`; `worker.js`; `renderers.js`; `controller.js`; `build.mjs`), so the reader can navigate the source.
  5. **How to build and run** — copy of the README steps (build with `npm run build`, double-click `shazam-demo.html`, Chrome/Edge for live, spacebar to advance), plus the rehearsal checklist.

  Keep prose clear and concise; use headings, short paragraphs, and code spans. No external resources (fonts/images/CDNs) — must open offline.

- [ ] **Step 2: Verify with Playwright MCP**
- `browser_navigate` to `file:///C:/Code/luke/shazam/docs/how-it-works.html`
- `browser_snapshot`: confirm all five section headings are present and the page renders (no missing-resource console errors).

- [ ] **Step 3: Commit** — `git add docs/how-it-works.html && git commit -m "docs: standalone how-it-works page"`

---

### Task 13: Polish, error states, rehearsal notes

**Files:**
- Modify: `src/styles.css` (projector polish), `src/controller.js` (guard no-DB-ready edge), any `src/*.js` needing a clarifying comment pass
- Create: `README.md`

**Interfaces:**
- Consumes: everything prior. No new exports.

- [ ] **Step 1: Readability pass** — skim each `src/*.js`; ensure the file-header comment and key-function comments are present and accurate (they were written alongside the code in earlier tasks; fix any that drifted). No behavior change.

- [ ] **Step 2: Guard the "mode clicked before DB ready" path** — the buttons are disabled until `Ready ✓`, but make `runCanned`/`runLive` also `await dbReady` defensively (already do). Confirm the live handler shows the friendly alert on mic denial (already wired in Task 9). No code change if already correct; otherwise adjust.

- [ ] **Step 3: Write `README.md`**

```markdown
# How Shazam Works — Live Demo

A single self-contained HTML file that walks through Shazam's recognition pipeline
and matches a song (live mic or canned clip) against the embedded tracks.

## Build
1. Put MP3s in `./songs/`, named `Artist - Song title.mp3` (5–10 recommended).
2. `npm run build` → produces `shazam-demo.html`.

## Run the demo
- Double-click `shazam-demo.html` (opens in your browser, fully offline).
- **Use Chrome or Edge for the live-mic path** (Safari often blocks mic on file://).
- Wait for "Ready ✓" on the start screen (songs are analysed in the background).
- **Canned playback:** pick a song, click ▶. **Live:** click 🎤, play the song into the mic for 10s
  (the waveform draws in real time as it records).
- Space / → = next stage, ← = previous, R = replay animation, ⛶ = fullscreen.

## Documentation
Open `docs/how-it-works.html` for a full explanation of the concepts and the code.

## Rehearsal checklist
- [ ] Grant mic permission once in the presentation browser.
- [ ] Confirm a live recording of a DB song lands the correct match.
- [ ] Have canned playback ready as the fallback.

## Test the DSP core
`npm test`

## Swap songs
Replace files in `./songs/`, re-run `npm run build`. Many full songs make a larger file
and a slower first-load analysis; ~5–10 is the sweet spot.
```

- [ ] **Step 4: Final DSP test + build** — Run: `npm test` (all PASS), then `npm run build` (succeeds).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "chore: polish, error handling, README rehearsal notes"`

---

## Verification (end-to-end)

- **DSP correctness:** `npm test` — all unit tests pass (FFT, STFT, peaks, fingerprint determinism, end-to-end synthetic match).
- **Build:** `npm run build` produces `shazam-demo.html`, printing song count + size (warns if large).
- **Self-test:** open `shazam-demo.html?selftest`, run `await window.__selfTest()` → top match equals the source song, score ≥ `minScore`.
- **Canned walkthrough (Playwright MCP):** open file, wait "Ready ✓", canned playback, step through all 6 stages via spacebar; Stage 2 shows a short slice + labelled sine components; Stage 3 stacks outward from the highlighted Stage-2 column; final reveal names the selected song; no console errors; screenshots per stage look correct.
- **Live path (manual rehearsal, Chrome/Edge):** grant mic, play a DB song for 10s, confirm the Stage-1 waveform draws in real time and the correct match reveals.
- **Docs page:** open `docs/how-it-works.html` offline; all five sections render; no missing-resource errors.
- **Offline check:** disconnect from the network and confirm both HTML files still open and run fully.

## Self-Review notes

- **Spec coverage:** six pipeline stages (Tasks 10–11); live + canned inputs with real-time Stage-1 waveform (Tasks 6, 9); background-worker fingerprinting + precompute-then-replay (Tasks 7, 8, 9); Stage 2 tens-of-ms sinusoid decomposition (Task 10, note #6); Stage 3 stacking from the shared slice (Task 10, note #7); swappable full songs + filename metadata + size warning (Task 8 build); single self-contained offline file (Task 8); no external libraries (all tasks); readable/commented code (all tasks + Task 13); standalone docs page incl. run steps (Task 12, notes #1/#3/#5); pure-DSP Node tests (Tasks 1–5); projector UX + fullscreen + rehearsal notes (Tasks 8, 13); Chrome/Edge-for-live guidance (README + controller error handling). Covered.
- **Type consistency:** `stageData` fields (`pcm, sr, spec, peaks, fingerprints, results, songs, matchedSong, focusFrame`) are consistent across controller (Task 9) and renderers (Tasks 10–11). `matchQuery` returns `{songId, score, offset}`, used identically in controller and the matching renderer. `spec` shape `{columns, numFrames, numBins}` is consistent from Task 2 on. Worker message contract `{id, pcm}` → `{id, fingerprints}` matches between `worker.js` (Task 7) and `controller.loadDatabase` (Task 8).
- **Tunable params:** peak/target-zone/`minScore` live in one `CONFIG` (Task 1); may need rehearsal tuning against real songs; noted in Global Constraints.
