// dsp.js — pure DSP core for the Shazam demo.
// Runs unchanged in Node (tests), the browser (<script>), and the Web Worker (self).
// No DOM, no Web Audio, no dependencies — just math on Float arrays.
(function (root) {
  // Tunable pipeline constants. Frames are ~93 ms at 11025 Hz; hop = 50% overlap.
  const CONFIG = {
    sampleRate: 11025, frameSize: 1024, hopSize: 512,
    peakNeighborhoodTime: 3, peakNeighborhoodFreq: 3, peaksPerFrameCap: 5,
    targetZoneMinDt: 1, targetZoneMaxDt: 63, targetZoneFreqRange: 200,
    fanout: 12, minScore: 5,
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

  // Like matchQuery, but keeps the full vote breakdown and a few example "shelves" (a hash and the
  // books on it: {songId, time-in-song}) for the matching-stage visualisation.
  function matchDetail(queryFps, db, cfg = CONFIG) {
    const votes = new Map(); // songId -> Map(offset -> count)
    let shelfHits = 0; // query fingerprints whose hash exists in the catalog (cast a vote)
    for (const { hash, t } of queryFps) {
      const arr = db.get(hash); if (!arr) continue; // no shelf for this hash → the voter casts nothing
      shelfHits++;
      for (const { songId, t: td } of arr) {
        const offset = td - t;
        let m = votes.get(songId); if (!m) { m = new Map(); votes.set(songId, m); }
        m.set(offset, (m.get(offset) || 0) + 1);
      }
    }
    const totalFps = queryFps.length, noShelf = totalFps - shelfHits;
    const results = [];
    for (const [songId, m] of votes) {
      let best = 0, bestOff = 0;
      for (const [off, c] of m) if (c > best) { best = c; bestOff = off; }
      results.push({ songId, score: best, offset: bestOff });
    }
    results.sort((a, b) => b.score - a.score);
    // Build example shelves: prefer the RICHEST shelves (most books = most different songs/points on
    // one hash) to show a shelf can hold many books, while GUARANTEEING at least two "correct" books
    // (the winning song at the winning offset) appear across the shown shelves.
    const winner = results[0] ? results[0].songId : null, winOff = results[0] ? results[0].offset : null;
    const isWin = bk => bk.songId === winner && bk.offset === winOff;
    // Order a shelf's books: the winning book(s) first, then round-robin across the OTHER songs so the
    // visible books show a VARIETY of songs rather than many of the same one (e.g. all Clocks).
    const orderBooks = books => {
      const wins = books.filter(isWin), bySong = new Map();
      for (const b of books) { if (isWin(b)) continue; if (!bySong.has(b.songId)) bySong.set(b.songId, []); bySong.get(b.songId).push(b); }
      const groups = [...bySong.values()], rr = [];
      for (let i = 0, more = true; more; i++) { more = false; for (const g of groups) if (i < g.length) { rr.push(g[i]); more = true; } }
      return [...wins, ...rr];
    };
    const cands = [], seen = new Set();
    for (const { hash, t } of queryFps) {
      if (seen.has(hash)) continue; seen.add(hash);
      const arr = db.get(hash); if (!arr || arr.length === 0) continue;
      const books = orderBooks(arr.map(e => ({ songId: e.songId, tSong: e.t, offset: e.t - t })));
      const otherSongs = new Set(books.filter(b => !isWin(b)).map(b => b.songId)).size; // variety of other songs
      cands.push({ hash, tq: t, books, winHits: books.filter(isWin).length, otherSongs });
    }
    const want = 5, chosen = [], has = h => chosen.some(c => c.hash === h);
    const byVariety = (a, b) => (b.otherSongs - a.otherSongs) || (b.books.length - a.books.length);
    // 1) the three most-varied shelves that also hold the correct book (guaranteed highlighted books)
    for (const c of cands.filter(c => c.winHits > 0).sort(byVariety)) { if (chosen.filter(x => x.winHits > 0).length >= 3) break; chosen.push(c); }
    // 2) fill remaining slots with the most-varied shelves overall (most different other songs)
    for (const c of [...cands].sort(byVariety)) { if (chosen.length >= want) break; if (!has(c.hash)) chosen.push(c); }
    const examples = chosen.map(c => ({ hash: c.hash, tq: c.tq, books: c.books }));
    return { results, votes, examples, totalFps, shelfHits, noShelf };
  }

  const DSP = { CONFIG, fft, hann, stft, findPeaks, fingerprint, buildDatabase, matchQuery, matchDetail };
  if (typeof module !== 'undefined' && module.exports) module.exports = DSP;
  else root.DSP = DSP;
})(typeof self !== 'undefined' ? self : this);
