// renderers.js — one canvas renderer per pipeline stage (waveform, fourier, spectrogram,
// peaks, fingerprints, matching). Each renderer takes a 0..1 progress value and draws that
// much of its stage's reveal animation against the shared stageData computed by controller.js.
(function (root) {
  root.Renderers = {};
  const D = root.DSP;
  const AX = '#6a6a88', FG = '#4be0c0';
  const HOT = ['#0a0a12', '#1a1a4a', '#4b2bff', '#ff5bd0', '#ffd24b', '#ffffff'];
  const heat = v => HOT[Math.round(Math.max(0, Math.min(0.999, v)) * (HOT.length - 1))];
  const COMP_COLORS = ['#4be0c0', '#ff5bd0', '#ffd24b', '#7b8cff', '#ff8a5b'];
  // Distinct hues so each anchor peak's fan of fingerprint connections reads as one group.
  const ANCHOR_COLORS = ['#4be0c0', '#ff5bd0', '#ffd24b', '#7b8cff', '#ff8a5b', '#5bd0ff', '#b98cff', '#9aff6b', '#ff6b8c', '#6be0ff', '#ffb14b', '#4bff9a', '#e06bff', '#8cff4b', '#5b9bff', '#ff4b6b'];

  // Faint time × frequency reference grid, drawn over the spectrogram cells.
  function drawGrid(ctx, W, H, cols = 16, rows = 8) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < cols; i++) { const x = (i / cols) * W; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let j = 1; j < rows; j++) { const y = (j / rows) * H; ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.restore();
  }

  // Labelled axes for the spectrogram: frequency (Hz) up the left, time (s) along the bottom.
  function drawSpectrogramAxes(ctx, W, H, sr, nT) {
    const nyq = sr / 2, dur = nT * D.CONFIG.hopSize / sr;
    ctx.save();
    ctx.fillStyle = 'rgba(10,10,18,0.6)';
    ctx.fillRect(0, 0, 54, H);            // left strip (behind the frequency labels)
    ctx.fillRect(54, H - 22, W - 54, 22); // bottom strip (behind the time labels)
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1; ctx.fillStyle = '#c8c8e0'; ctx.font = '12px system-ui';
    ctx.textAlign = 'right';
    for (let hz = 1000; hz <= nyq; hz += 1000) {          // frequency ticks: 1k, 2k, … up to Nyquist
      const y = H - (hz / nyq) * H; if (y > H - 24) continue;
      ctx.beginPath(); ctx.moveTo(48, y); ctx.lineTo(54, y); ctx.stroke();
      ctx.fillText((hz / 1000) + 'k', 45, y + 4);
    }
    ctx.textAlign = 'left';
    const step = dur > 8 ? 2 : 1;
    for (let s = step; s <= dur + 0.01; s += step) {       // time ticks
      const x = (s / dur) * W; if (x < 60 || x > W - 22) continue;
      ctx.beginPath(); ctx.moveTo(x, H - 22); ctx.lineTo(x, H - 16); ctx.stroke();
      ctx.fillText(s + 's', x + 3, H - 7);
    }
    ctx.fillStyle = '#9a9ac8'; ctx.font = 'bold 12px system-ui';
    ctx.save(); ctx.translate(14, H / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('frequency (Hz)', 0, 0); ctx.restore();
    ctx.textAlign = 'left'; ctx.fillText('time (s)', W - 64, H - 7);
    ctx.restore();
  }

  // Stage 1: air pressure over time. Draws d.pcm up to `p` (canned) or the whole buffer (live).
  // Once drawn, highlights the slice Stage 2 will zoom into; while the clip plays, d.playhead
  // (0..1) draws a moving cursor at the current sample.
  root.Renderers.waveform = (ctx, d, p, W, H) => {
    const pcm = d.pcm, n = pcm.length, mid = H / 2, show = Math.floor(n * p);
    ctx.strokeStyle = FG; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const i = Math.floor((x / W) * n); if (i > show) break;
      ctx.lineTo(x, mid + (pcm[i] || 0) * mid * 0.9);
    }
    ctx.stroke();
    // highlight the slice Stage 2 analyses (once the waveform has finished drawing)
    if (p >= 1 && d.focusFrame != null && n > 0) {
      const s = d.focusFrame * D.CONFIG.hopSize;
      const x0 = (s / n) * W, w = Math.max(6, (D.CONFIG.frameSize / n) * W);
      ctx.fillStyle = 'rgba(123,140,255,0.25)'; ctx.fillRect(x0, 0, w, H);
      ctx.strokeStyle = '#7b8cff'; ctx.lineWidth = 2; ctx.strokeRect(x0, 0, w, H);
      ctx.fillStyle = '#7b8cff'; ctx.font = '13px system-ui';
      ctx.fillText('drag to move — analysed in Fourier', Math.min(x0 + w + 8, W - 270), 42);
    }
    // playback cursor (only while playing)
    if (d.playhead != null) {
      const cx = Math.max(0, Math.min(1, d.playhead)) * W;
      ctx.strokeStyle = '#ffd24b'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
    }
    ctx.fillStyle = AX; ctx.font = '16px system-ui';
    ctx.fillText('amplitude (air pressure) →', 12, 22);
    ctx.fillText('time →', W - 70, H - 12);
  };

  // Stage 2 (note #6): first a minimap of the whole clip with the analysed slice highlighted
  // (continuity from Stage 1), then that ~tens-of-ms slice decomposing into its strongest sines.
  root.Renderers.fourier = (ctx, d, p, W, H) => {
    const frame = D.CONFIG.frameSize, sr = d.sr, start = d.focusFrame * D.CONFIG.hopSize;
    const pad = 40, n = d.pcm.length, inner = W - 2 * pad;
    const mmH = H * 0.16, sliceTop = mmH + 46, sliceH = H * 0.20;
    // --- minimap: the whole recording, with the analysed slice highlighted ---
    ctx.strokeStyle = '#2f6f63'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x <= inner; x++) {
      const i = Math.floor((x / inner) * n), y = mmH / 2 + (d.pcm[i] || 0) * (mmH / 2) * 0.9;
      x ? ctx.lineTo(pad + x, y) : ctx.moveTo(pad + x, y);
    }
    ctx.stroke();
    const mmx0 = pad + (start / n) * inner, mmw = Math.max(4, (frame / n) * inner);
    ctx.fillStyle = 'rgba(123,140,255,0.30)'; ctx.fillRect(mmx0, 0, mmw, mmH);
    ctx.strokeStyle = '#7b8cff'; ctx.lineWidth = 2; ctx.strokeRect(mmx0, 0, mmw, mmH);
    ctx.fillStyle = AX; ctx.font = '13px system-ui';
    ctx.fillText('the whole recording — drag the highlighted slice to move it', pad, mmH + 16);
    // --- the zoomed slice ---
    ctx.strokeStyle = FG; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < frame; i++) {
      const x = pad + (i / frame) * inner, y = sliceTop + sliceH / 2 + (d.pcm[start + i] || 0) * (sliceH / 2) * 0.9;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = AX; ctx.font = '15px system-ui';
    ctx.fillText(`this ~${Math.round(frame / sr * 1000)} ms slice =`, pad, sliceTop - 4);
    ctx.fillText('a sum of sine waves — the bar shows how much of each frequency:', pad, sliceTop + sliceH + 20);
    // --- FFT the windowed slice, pick the strongest few components ---
    const win = D.hann(frame), re = new Float64Array(frame), im = new Float64Array(frame);
    for (let i = 0; i < frame; i++) { re[i] = (d.pcm[start + i] || 0) * win[i]; im[i] = 0; }
    D.fft(re, im);
    const bins = frame / 2, comps = [];
    for (let b = 1; b < bins; b++) comps.push({ b, mag: Math.hypot(re[b], im[b]), phase: Math.atan2(im[b], re[b]) });
    comps.sort((a, b) => b.mag - a.mag);
    const K = 5, top = comps.slice(0, K), maxMag = (top[0] && top[0].mag > 0) ? top[0].mag : 1;
    const rowsTop = sliceTop + sliceH + 34, rowH = (H - rowsTop) / K;
    const gutter = 220, sineW = inner - gutter;   // reserve a right-hand strip for amplitude bars
    const gx = pad + sineW + 20, barMax = gutter - 100;
    ctx.fillStyle = AX; ctx.font = '13px system-ui';
    ctx.fillText('frequency · amount', gx, rowsTop - 8);
    const shown = Math.max(1, Math.round(K * p));
    for (let k = 0; k < shown; k++) {
      const c = top[k], f = c.b * sr / frame, amp = c.mag / maxMag, cy = rowsTop + rowH * (k + 0.5);
      // the pure sine (its height also scales with amplitude)
      ctx.strokeStyle = COMP_COLORS[k % COMP_COLORS.length]; ctx.lineWidth = 1.5; ctx.beginPath();
      for (let xx = 0; xx <= sineW; xx++) {
        const tt = (xx / sineW) * (frame / sr);
        const y = cy + Math.sin(2 * Math.PI * f * tt + c.phase) * amp * (rowH * 0.4);
        xx ? ctx.lineTo(pad + xx, y) : ctx.moveTo(pad + xx, y);
      }
      ctx.stroke();
      // frequency label + amplitude bar: how much of THIS frequency is present, vs the others
      ctx.fillStyle = AX; ctx.font = '13px system-ui';
      ctx.fillText(`${Math.round(f)} Hz`, gx, cy - 6);
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(gx, cy + 3, barMax, 9);
      ctx.fillStyle = COMP_COLORS[k % COMP_COLORS.length]; ctx.fillRect(gx, cy + 3, barMax * amp, 9);
      ctx.fillStyle = AX; ctx.fillText(`${Math.round(amp * 100)}%`, gx + barMax + 8, cy + 12);
    }
  };

  // Stage 3 (note #7): reveal expands outward from the Stage-2 slice column so that single
  // FFT result is visibly "stacked" into the full time × frequency spectrogram.
  root.Renderers.spectrogram = (ctx, d, p, W, H, hideFocus) => {
    const cols = d.spec.columns, nT = d.spec.numFrames, nB = d.spec.numBins;
    let max = d.__specMax;
    if (!max) { max = 1e-9; for (const c of cols) for (let b = 0; b < nB; b++) if (c[b] > max) max = c[b]; d.__specMax = max; }
    const cw = W / nT, ch = H / nB, focus = d.focusFrame;
    // Stage 3 holds on the focus column first (so its frequencies register), then expands outward.
    const revealP = hideFocus ? p : Math.max(0, (p - 0.35) / 0.65);
    const reach = Math.round(nT * revealP);
    const lo = Math.max(0, focus - reach), hi = Math.min(nT - 1, focus + reach);
    for (let t = lo; t <= hi; t++) {
      const c = cols[t];
      for (let b = 0; b < nB; b++) {
        const v = Math.log1p(c[b]) / Math.log1p(max);
        if (v < 0.06) continue;
        ctx.fillStyle = heat(v); ctx.fillRect(t * cw, H - (b + 1) * ch, cw + 1, ch + 1);
      }
    }
    drawGrid(ctx, W, H); // faint reference grid over the spectrogram (Stage 3 and behind Stage 4)
    if (!hideFocus) { // the Stage-2 slice column, emphasised then blended into the full spectrogram
      const emph = Math.max(0, 1 - Math.max(0, p - 0.45) / 0.45); // hold the markers longer, fade by p≈0.9
      const fx = focus * cw, colW = Math.max(cw, 6);
      if (emph > 0.02) {
        const col = cols[focus];
        // brighten the focus column so its frequencies read as "the Fourier result being placed"
        for (let b = 0; b < nB; b++) {
          const v = Math.log1p(col[b]) / Math.log1p(max);
          if (v < 0.06) continue;
          ctx.globalAlpha = emph; ctx.fillStyle = heat(Math.min(0.999, v * 1.3));
          ctx.fillRect(fx - (colW - cw) / 2, H - (b + 1) * ch, colW, ch + 1);
        }
        // mark the strongest frequencies (matching Stage 2's components), fading out
        const comps = []; for (let b = 1; b < nB; b++) comps.push({ b, m: col[b] });
        comps.sort((a, b) => b.m - a.m);
        for (let k = 0; k < 5 && k < comps.length; k++) {
          const b = comps[k].b, y = H - (b / nB) * H, hz = Math.round(b * d.sr / D.CONFIG.frameSize);
          ctx.globalAlpha = emph; ctx.strokeStyle = COMP_COLORS[k % COMP_COLORS.length]; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(fx - 14, y); ctx.lineTo(fx + colW + 14, y); ctx.stroke();
          ctx.fillStyle = COMP_COLORS[k % COMP_COLORS.length]; ctx.font = '12px system-ui';
          ctx.fillText(`${hz} Hz`, fx + colW + 18, y + 4);
        }
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(fx - 1, 0, cw + 2, H);
      ctx.fillStyle = AX; ctx.font = '15px system-ui';
      ctx.fillText(emph > 0.25
        ? 'the Fourier result for this slice → placed as one column…'
        : 'the slice from Stage 2 → one column; the rest stack in around it', 12, 20);
      drawSpectrogramAxes(ctx, W, H, d.sr, nT); // labelled frequency (Hz) & time (s) axes
    } else {
      ctx.fillStyle = AX; ctx.font = '15px system-ui';
      ctx.fillText('frequency ↑', 10, H - 12); ctx.fillText('time →', W - 60, H - 12);
    }
  };

  const px = (t, nT, W) => (t / nT) * W;
  const py = (f, nB, H) => H - (f / nB) * H;
  // Truncate text with an ellipsis so it fits within maxW (uses the current ctx.font).
  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  // Stage 4: keep the spectrogram bright while the peaks light up ON the bright spots, THEN
  // fade the background down — so the constellation is clearly picked out (not everything at once).
  root.Renderers.peaks = (ctx, d, p, W, H) => {
    const nT = d.spec.numFrames, nB = d.spec.numBins;
    const bg = p < 0.5 ? 0.85 : Math.max(0.12, 0.85 - (p - 0.5) * 2 * 0.73); // bright, then fade
    ctx.globalAlpha = bg;
    root.Renderers.spectrogram(ctx, d, 1, W, H, true);
    ctx.globalAlpha = 1;
    const shown = Math.floor(d.peaks.length * p);
    ctx.fillStyle = '#ffd24b';
    for (let i = 0; i < shown; i++) {
      const pk = d.peaks[i];
      ctx.beginPath(); ctx.arc(px(pk.t, nT, W), py(pk.f, nB, H), 3, 0, 7); ctx.fill();
    }
    ctx.fillStyle = AX; ctx.font = '15px system-ui';
    ctx.fillText('strongest peaks light up, then the rest fades → constellation map', 12, 22);
  };

  // Stage 5: each anchor peak (in its own colour) fans out to peaks in its target zone.
  // Two views (toggled by the controller via d.fpMode):
  //   'spread' — ~40 sampled anchors; click a pairing line to inspect its (f₁, f₂, Δt, hash).
  //   'all'    — every peak is an anchor (the full fingerprint set), coloured per anchor.
  root.Renderers.fingerprints = (ctx, d, p, W, H) => {
    const nT = d.spec.numFrames, nB = d.spec.numBins;

    if (d.fpMode === 'all') {
      // Every peak is an anchor, fanning to up to `fanout` targets (mirrors fingerprint()).
      let all = d.__fpAll;
      if (!all) {
        const sorted = [...d.peaks].sort((a, b) => a.t - b.t || a.f - b.f);
        all = [];
        for (let ai = 0; ai < sorted.length; ai++) {
          const a = sorted[ai]; let paired = 0;
          for (let j = ai + 1; j < sorted.length && paired < D.CONFIG.fanout; j++) {
            const b = sorted[j], dt = b.t - a.t;
            if (dt < D.CONFIG.targetZoneMinDt) continue;
            if (dt > D.CONFIG.targetZoneMaxDt) break;
            if (Math.abs(b.f - a.f) > D.CONFIG.targetZoneFreqRange) continue;
            all.push([a, b, ai]); paired++;
          }
        }
        d.__fpAll = all;
      }
      const shown = Math.floor(p * p * all.length);
      ctx.lineWidth = 1; ctx.globalAlpha = 0.5;
      for (let i = 0; i < shown; i++) {
        const s = all[i]; ctx.strokeStyle = ANCHOR_COLORS[s[2] % ANCHOR_COLORS.length];
        ctx.beginPath(); ctx.moveTo(px(s[0].t, nT, W), py(s[0].f, nB, H)); ctx.lineTo(px(s[1].t, nT, W), py(s[1].f, nB, H)); ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.fillStyle = '#ffd24b';
      for (const pk of d.peaks) { ctx.beginPath(); ctx.arc(px(pk.t, nT, W), py(pk.f, nB, H), 1.5, 0, 7); ctx.fill(); }
      ctx.fillStyle = AX; ctx.font = '15px system-ui';
      ctx.fillText(`every peak is an anchor — all ${all.length} fingerprints`, 12, 22);
      ctx.fillStyle = '#e8e8f0'; ctx.font = '18px system-ui';
      if (d.fingerprints[0]) ctx.fillText(`(f₁, f₂, Δt) → hash 0x${(d.fingerprints[0].hash >>> 0).toString(16)}`, 12, H - 16);
      return;
    }

    // --- Spread view (clickable) ---
    let fans = d.__fpFans;
    if (!fans) {
      const step = Math.max(1, Math.floor(d.peaks.length / 40));
      const chosen = d.peaks.filter((_, i) => i % step === 0).slice(0, 40).sort((a, b) => a.t - b.t || a.f - b.f);
      const sorted = [...d.peaks].sort((a, b) => a.t - b.t || a.f - b.f);
      fans = chosen.map((a, ai) => {
        const targets = []; let paired = 0;
        for (const b of sorted) {
          if (paired >= D.CONFIG.fanout) break;
          const dt = b.t - a.t;
          if (dt < D.CONFIG.targetZoneMinDt) continue;
          if (dt > D.CONFIG.targetZoneMaxDt) break;
          if (Math.abs(b.f - a.f) > D.CONFIG.targetZoneFreqRange) continue;
          targets.push(b); paired++;
        }
        return { a, targets, ai };
      }).filter(f => f.targets.length > 0);
      d.__fpFans = fans;
      d.__fpAnchorSet = new Set(fans.map(f => f.a));
    }
    if (!d.fpSegments) d.fpSegments = fans.flatMap(f => f.targets.map(b => ({ a: f.a, b, ai: f.ai }))); // for click hit-testing
    const segs = d.fpSegments, anchorSet = d.__fpAnchorSet;
    ctx.fillStyle = 'rgba(255,210,75,0.35)';
    for (const pk of d.peaks) { if (!anchorSet.has(pk)) { ctx.beginPath(); ctx.arc(px(pk.t, nT, W), py(pk.f, nB, H), 2, 0, 7); ctx.fill(); } }
    const shown = Math.floor(p * p * segs.length); // ease-in reveal
    ctx.lineWidth = 1.5;
    for (let i = 0; i < shown; i++) {
      const s = segs[i]; ctx.strokeStyle = ANCHOR_COLORS[s.ai % ANCHOR_COLORS.length];
      ctx.beginPath(); ctx.moveTo(px(s.a.t, nT, W), py(s.a.f, nB, H)); ctx.lineTo(px(s.b.t, nT, W), py(s.b.f, nB, H)); ctx.stroke();
    }
    fans.forEach(f => { ctx.fillStyle = ANCHOR_COLORS[f.ai % ANCHOR_COLORS.length]; ctx.beginPath(); ctx.arc(px(f.a.t, nT, W), py(f.a.f, nB, H), 4.5, 0, 7); ctx.fill(); });
    // selected fingerprint: highlight + info panel
    const sel = d.fpSelected;
    if (sel) {
      const ax = px(sel.a.t, nT, W), ay = py(sel.a.f, nB, H), bx = px(sel.b.t, nT, W), by = py(sel.b.f, nB, H);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ax, ay, 5, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(bx, by, 5, 0, 7); ctx.fill();
      const pw = 252, ph = 118, pxx = W - pw - 16, pyy = 42;
      ctx.fillStyle = 'rgba(10,10,18,0.92)'; ctx.fillRect(pxx, pyy, pw, ph);
      ctx.strokeStyle = '#4be0c0'; ctx.lineWidth = 1.5; ctx.strokeRect(pxx, pyy, pw, ph);
      ctx.fillStyle = '#e8e8f0'; ctx.font = 'bold 14px system-ui'; ctx.fillText('this fingerprint', pxx + 12, pyy + 22);
      ctx.font = '13px system-ui'; ctx.fillStyle = '#c8c8e0';
      ctx.fillText(`f₁ (start freq): ${sel.f1} Hz`, pxx + 12, pyy + 46);
      ctx.fillText(`f₂ (end freq):  ${sel.f2} Hz`, pxx + 12, pyy + 66);
      ctx.fillText(`Δt (time gap):  ${sel.dtMs} ms`, pxx + 12, pyy + 86);
      ctx.fillStyle = '#4be0c0'; ctx.font = 'bold 14px system-ui';
      ctx.fillText(`hash 0x${sel.hash.toString(16)}`, pxx + 12, pyy + 108);
    }
    ctx.fillStyle = AX; ctx.font = '15px system-ui';
    ctx.fillText('each coloured anchor pairs with peaks in its target zone — click a line to inspect', 12, 22);
    ctx.fillStyle = '#e8e8f0'; ctx.font = '18px system-ui';
    if (d.fingerprints[0]) ctx.fillText(`(f₁, f₂, Δt) → hash 0x${(d.fingerprints[0].hash >>> 0).toString(16)}`, 12, H - 16);
  };

  // Stage 6: the library. LEFT — example shelves (hash values) holding books (song, time-in-song)
  // with the offset worked out on each. RIGHT — votes by song & time-offset; the match spikes.
  root.Renderers.matching = (ctx, d, p, W, H) => {
    const det = d.matchDetail || { results: [], votes: new Map(), examples: [] };
    const best = det.results[0];
    const songs = d.songs || [];
    const idx = id => songs.findIndex(s => s.id === id);
    const colorFor = id => ANCHOR_COLORS[(idx(id) + ANCHOR_COLORS.length) % ANCHOR_COLORS.length];
    const titleOf = id => { const s = songs.find(x => x.id === id); return s ? s.title : id; };
    const F2S = fr => fr * D.CONFIG.hopSize / d.sr; // frames -> seconds
    const midX = Math.round(W * 0.5);
    const isWinBook = b => best && b.songId === best.songId && b.offset === best.offset;

    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(midX, 44); ctx.lineTo(midX, H - 20); ctx.stroke();

    // ---------------- LEFT: shelves & books ----------------
    const LX = 16, LW = midX - 40;
    ctx.fillStyle = '#e8e8f0'; ctx.font = 'bold 16px system-ui';
    ctx.fillText('Each hash = a shelf; each book = (song, time in song)', LX, 26);
    const shelves = det.examples || [];
    const nSh = shelves.length || 1;
    const revealSh = Math.min(shelves.length, Math.ceil(shelves.length * Math.min(1, p / 0.45)));
    const shH = Math.min(150, (H - 70) / nSh);
    for (let s = 0; s < revealSh; s++) {
      const sh = shelves[s], y = 48 + s * shH;
      ctx.fillStyle = '#9a9ac8'; ctx.font = '13px system-ui';
      ctx.fillText(`shelf  0x${(sh.hash >>> 0).toString(16)}   ·   heard at ${F2S(sh.tq).toFixed(1)}s`, LX, y + 14);
      // shelf plank
      ctx.strokeStyle = '#8a7a5a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(LX, y + shH - 14); ctx.lineTo(LX + LW, y + shH - 14); ctx.stroke();
      // books (winning books are sorted first, so they stay visible on rich shelves)
      const bw = 118, gap = 10, bh = shH - 46; let bx = LX + 2, drawn = 0;
      for (const b of sh.books) {
        if (bx + bw + 44 > LX + LW) break; // leave room for a "+N more" note
        const win = isWinBook(b);
        ctx.globalAlpha = win ? 1 : 0.55; ctx.fillStyle = colorFor(b.songId);
        ctx.fillRect(bx, y + 20, bw, bh); ctx.globalAlpha = 1;
        if (win) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(bx, y + 20, bw, bh); }
        ctx.fillStyle = '#0a0a12'; ctx.font = 'bold 12px system-ui';
        ctx.fillText(fitText(ctx, titleOf(b.songId), bw - 12), bx + 6, y + 38);
        ctx.font = '11px system-ui';
        ctx.fillText(`in song: ${F2S(b.tSong).toFixed(1)}s`, bx + 6, y + 20 + bh - 24);
        ctx.fillStyle = win ? '#fff' : '#0a0a12'; ctx.font = 'bold 11px system-ui';
        ctx.fillText(`offset ${F2S(b.offset).toFixed(1)}s`, bx + 6, y + 20 + bh - 8);
        bx += bw + gap; drawn++;
      }
      if (sh.books.length > drawn) { // this hash holds even more books
        ctx.fillStyle = '#c8c8e0'; ctx.font = 'bold 13px system-ui';
        ctx.fillText(`+${sh.books.length - drawn}`, bx + 2, y + 20 + bh / 2 - 2);
        ctx.font = '10px system-ui'; ctx.fillText('more', bx + 2, y + 20 + bh / 2 + 12);
      }
    }

    // ---------------- RIGHT: vote chart ----------------
    const RX = midX + 24, RW = W - RX - 20;
    ctx.fillStyle = '#e8e8f0'; ctx.font = 'bold 16px system-ui';
    ctx.fillText('Votes by song & time-offset', RX, 26);
    // offset range + max count
    let offMin = Infinity, offMax = -Infinity, maxCount = 1;
    for (const [, m] of det.votes) for (const [off, c] of m) { if (off < offMin) offMin = off; if (off > offMax) offMax = off; if (c > maxCount) maxCount = c; }
    if (!isFinite(offMin)) { offMin = 0; offMax = 1; }
    const cX = RX, cW = RW, cY = 52, cH = Math.max(80, H * 0.42);
    const eased = Math.min(1, p / 0.9);
    // axes
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cX, cY + cH); ctx.lineTo(cX + cW, cY + cH); ctx.stroke();
    // bars: one thin bar per (song, offset)
    for (const [sid, m] of det.votes) {
      ctx.fillStyle = colorFor(sid);
      for (const [off, c] of m) {
        const x = cX + ((off - offMin) / Math.max(1, offMax - offMin)) * (cW - 6);
        const bh = (c / maxCount) * cH * eased;
        ctx.fillRect(x, cY + cH - bh, 3, bh);
      }
    }
    ctx.fillStyle = AX; ctx.font = '13px system-ui';
    ctx.fillText('time offset →', cX + cW - 96, cY + cH + 18);
    ctx.save(); ctx.translate(cX - 6, cY + cH / 2 + 20); ctx.rotate(-Math.PI / 2); ctx.fillText('votes', 0, 0); ctx.restore();
    // per-song tally (votes for each song)
    let ly = cY + cH + 44;
    ctx.font = '14px system-ui';
    for (let i = 0; i < det.results.length && ly < H - 10; i++) {
      const r = det.results[i], winRow = best && r.songId === best.songId;
      ctx.fillStyle = colorFor(r.songId); ctx.fillRect(cX, ly - 11, 14, 14);
      ctx.fillStyle = winRow ? '#fff' : '#9a9ac8'; ctx.font = winRow ? 'bold 15px system-ui' : '14px system-ui';
      ctx.fillText(`${fitText(ctx, titleOf(r.songId), cW - 140)} — ${Math.round(r.score * eased)} votes`, cX + 22, ly);
      ly += 24;
    }

    // ---------------- reveal (keeps shelves + chart visible) ----------------
    if (p >= 1) {
      const bannerY = cY + 2;
      if (best && d.matchedSong) {
        const startSec = Math.max(0, F2S(best.offset)); // the winning offset = where the recording began
        const mm = Math.floor(startSec / 60), ss = Math.round(startSec % 60);
        const startStr = mm + ':' + String(ss).padStart(2, '0');
        ctx.fillStyle = colorFor(best.songId); ctx.fillRect(cX, bannerY, cW, 52);
        ctx.fillStyle = '#0a0a12'; ctx.font = 'bold 18px system-ui';
        ctx.fillText(fitText(ctx, `✓ MATCH: ${d.matchedSong.title} — ${d.matchedSong.artist}`, cW - 20), cX + 10, bannerY + 22);
        ctx.font = 'bold 13px system-ui';
        ctx.fillText(fitText(ctx, `${best.score} votes · recording started ~${startStr} into the song`, cW - 20), cX + 10, bannerY + 42);
      } else {
        ctx.fillStyle = '#3a1a1a'; ctx.fillRect(cX, bannerY, cW, 34);
        ctx.fillStyle = '#ff8a8a'; ctx.font = 'bold 16px system-ui';
        ctx.fillText(best ? `No confident match (top only ${best.score} votes)` : 'No candidate votes', cX + 10, bannerY + 22);
      }
    }
  };
})(typeof self !== 'undefined' ? self : this);
