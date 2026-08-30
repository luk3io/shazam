// renderers.js — one canvas renderer per pipeline stage. Filled in Tasks 10-11.
(function (root) {
  root.Renderers = {};
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
})(typeof self !== 'undefined' ? self : this);
