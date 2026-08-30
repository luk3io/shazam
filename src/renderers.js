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
    const mmH = H * 0.16, sliceTop = mmH + 26, sliceH = H * 0.20;
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
    ctx.fillText('a sum of sine waves:', pad, sliceTop + sliceH + 20);
    // --- FFT the windowed slice, pick the strongest few components ---
    const win = D.hann(frame), re = new Float64Array(frame), im = new Float64Array(frame);
    for (let i = 0; i < frame; i++) { re[i] = (d.pcm[start + i] || 0) * win[i]; im[i] = 0; }
    D.fft(re, im);
    const bins = frame / 2, comps = [];
    for (let b = 1; b < bins; b++) comps.push({ b, mag: Math.hypot(re[b], im[b]), phase: Math.atan2(im[b], re[b]) });
    comps.sort((a, b) => b.mag - a.mag);
    const K = 5, top = comps.slice(0, K), maxMag = (top[0] && top[0].mag > 0) ? top[0].mag : 1;
    const rowsTop = sliceTop + sliceH + 34, rowH = (H - rowsTop) / K;
    const shown = Math.max(1, Math.round(K * p));
    for (let k = 0; k < shown; k++) {
      const c = top[k], f = c.b * sr / frame, amp = c.mag / maxMag, cy = rowsTop + rowH * (k + 0.5);
      ctx.strokeStyle = COMP_COLORS[k % COMP_COLORS.length]; ctx.lineWidth = 1.5; ctx.beginPath();
      for (let xx = 0; xx <= inner; xx++) {
        const tt = (xx / inner) * (frame / sr);
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
  root.Renderers.spectrogram = (ctx, d, p, W, H, hideFocus) => {
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
    drawGrid(ctx, W, H); // faint reference grid over the spectrogram (Stage 3 and behind Stage 4)
    if (!hideFocus) { // the Stage-2 slice column + its caption (skipped when Stage 4 reuses this)
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(focus * cw - 1, 0, cw + 2, H);
      ctx.fillStyle = AX; ctx.font = '15px system-ui';
      ctx.fillText('the slice from Stage 2 → one column; the rest stack in around it', 12, 20);
    }
    ctx.fillStyle = AX; ctx.font = '15px system-ui';
    ctx.fillText('frequency ↑', 10, H - 12); ctx.fillText('time →', W - 60, H - 12);
  };

  const px = (t, nT, W) => (t / nT) * W;
  const py = (f, nB, H) => H - (f / nB) * H;

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

  // Stage 5: draw target-zone pairing lines from a few anchors, and show one packed hash.
  root.Renderers.fingerprints = (ctx, d, p, W, H) => {
    const nT = d.spec.numFrames, nB = d.spec.numBins;
    ctx.fillStyle = '#ffd24b';
    for (const pk of d.peaks) { ctx.beginPath(); ctx.arc(px(pk.t, nT, W), py(pk.f, nB, H), 2.5, 0, 7); ctx.fill(); }
    // Build the pairing connections once, then reveal them one-by-one, accelerating (slow → fast).
    let segs = d.__fpSegs;
    if (!segs) {
      segs = [];
      const anchors = d.peaks.filter((_, i) => i % 25 === 0).slice(0, 14);
      for (const a of anchors) for (const b of d.peaks) {
        const dt = b.t - a.t;
        if (dt >= D.CONFIG.targetZoneMinDt && dt <= D.CONFIG.targetZoneMaxDt && Math.abs(b.f - a.f) <= D.CONFIG.targetZoneFreqRange) segs.push([a, b]);
      }
      d.__fpSegs = segs;
    }
    const shown = Math.floor(p * p * segs.length); // p*p = ease-in: slow at first, then speeding up
    ctx.strokeStyle = FG; ctx.lineWidth = 1.5;
    for (let i = 0; i < shown; i++) {
      const a = segs[i][0], b = segs[i][1];
      ctx.beginPath(); ctx.moveTo(px(a.t, nT, W), py(a.f, nB, H)); ctx.lineTo(px(b.t, nT, W), py(b.f, nB, H)); ctx.stroke();
    }
    if (shown > 0) { // emphasise the connection most recently added
      const a = segs[shown - 1][0], b = segs[shown - 1][1];
      ctx.strokeStyle = '#ffd24b'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(px(a.t, nT, W), py(a.f, nB, H)); ctx.lineTo(px(b.t, nT, W), py(b.f, nB, H)); ctx.stroke();
    }
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
    if (p >= 1) {
      ctx.fillStyle = 'rgba(10,10,18,.82)'; ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      if (d.matchedSong) {
        ctx.fillStyle = FG; ctx.font = 'bold 30px system-ui'; ctx.fillText('MATCH', W / 2, H / 2 - 40);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 40px system-ui'; ctx.fillText(d.matchedSong.title, W / 2, H / 2 + 6);
        ctx.fillStyle = '#9a9ac8'; ctx.font = '24px system-ui';
        ctx.fillText(`${d.matchedSong.artist}   ·   ${best.score} votes`, W / 2, H / 2 + 48);
      } else {
        ctx.fillStyle = '#ff5b5b'; ctx.font = 'bold 30px system-ui'; ctx.fillText('No confident match', W / 2, H / 2 - 10);
        ctx.fillStyle = '#9a9ac8'; ctx.font = '20px system-ui';
        ctx.fillText(best ? `top guess only reached ${best.score} votes` : 'no candidate votes at all', W / 2, H / 2 + 30);
      }
      ctx.textAlign = 'left';
    }
  };
})(typeof self !== 'undefined' ? self : this);
