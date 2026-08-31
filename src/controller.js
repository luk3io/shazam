// controller.js — orchestrates the demo: loads the song database via the worker, drives the
// canned/live capture flow, precomputes every stage's data up front, and runs the six-stage
// pipeline UI (stage tracker, canvas draw loop, keyboard/button navigation). Also exposes a
// window.__selfTest() hook (enabled via ?selftest) for headless verification.
(function (root) {
  const D = root.DSP, IO = root.AudioIO;

  // Spawn the fingerprint worker from the embedded source (works offline on file://).
  function makeWorker() {
    const blob = new Blob([root.WORKER_SOURCE], { type: 'text/javascript' });
    return new Worker(URL.createObjectURL(blob));
  }

  // Decode each song on the main thread, fingerprint it in the worker, and build the DB.
  // Resilient to a single bad song: skip it (console.warn) and keep going, so a corrupt
  // file or worker hiccup on one track doesn't brick the whole demo.
  async function loadDatabase(songs, onProgress) {
    const worker = makeWorker();
    const perSong = [];
    for (let i = 0; i < songs.length; i++) {
      const s = songs[i];
      try {
        s._pcm = await IO.decodeToMono(IO.base64ToArrayBuffer(s.data));
        const fingerprints = await new Promise((res, reject) => {
          worker.onmessage = e => res(e.data.fingerprints);
          worker.onerror = e => reject(e.message ? new Error(e.message) : e);
          const copy = s._pcm.slice();               // keep our pcm; transfer a copy
          worker.postMessage({ id: s.id, pcm: copy }, [copy.buffer]);
        });
        perSong.push({ songId: s.id, fingerprints });
      } catch (err) {
        console.warn(`Skipping song "${s.title || s.id}" — failed to load/fingerprint:`, err);
      }
      if (onProgress) onProgress(Math.round(((i + 1) / songs.length) * 100));
    }
    worker.terminate();
    if (perSong.length === 0) throw new Error('No songs loaded successfully');
    return D.buildDatabase(perSong);
  }
  root.App = { loadDatabase, makeWorker };

  const STAGES = [
    ['waveform',     'A microphone records the song as a waveform — air pressure over time.'],
    ['fourier',      'Zoom into a short slice: the Fourier transform splits it into sine waves.'],
    ['spectrogram',  'Stack each slice’s frequencies over time to form a spectrogram.'],
    ['peaks',        'Keep only the strongest peaks — a constellation that survives noise.'],
    ['fingerprints', 'Pair peaks into hashes: (f₁, f₂, Δt) → a 32-bit fingerprint.'],
    ['matching',     'Votes for the same song at the same time-offset reveal the match.'],
  ];
  const STAGE_SUBSTEPS = [1, 1, 2, 1, 1, 2]; // spectrogram (2) and matching (2) reveal over two Next presses
  const $ = id => document.getElementById(id);
  let canvas, ctx, stageData = null, db = null, dbReady = null, stageIdx = 0, anim = null, playSource = null, playAnim = null, subStep = 0;
  let fpMode = 'spread'; // fingerprints view: 'spread' (~40 anchors, clickable) or 'all' (every fingerprint)

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
    ctx.textAlign = 'left'; ctx.globalAlpha = 1; // reset any state a previous stage's renderer left
    if (!stageData) return; // nothing to render (e.g. after returning to the start screen)
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
  // Stage-1 "Play clip" button: lets the audience hear the recording they're looking at.
  function stopPlayback() {
    if (playSource) { playSource.stop(); playSource = null; }
    cancelAnimationFrame(playAnim);
    if (stageData) { stageData.playhead = null; if (stageIdx === 0) draw(1); } // clear the cursor
    $('playBtn').textContent = '▶ Play clip';
  }
  // While the clip plays, advance a playback cursor on the Stage-1 waveform each frame.
  function startPlayheadLoop() {
    cancelAnimationFrame(playAnim);
    const tick = () => {
      if (!playSource || stageIdx !== 0 || !stageData) { stopPlayback(); return; }
      stageData.playhead = Math.min(1, playSource.elapsed() / (playSource.duration || 1));
      draw(1);
      if (playSource.isEnded() || stageData.playhead >= 1) { stopPlayback(); return; }
      playAnim = requestAnimationFrame(tick);
    };
    playAnim = requestAnimationFrame(tick);
  }
  function updatePlayBtn() {
    $('playBtn').classList.toggle('hidden', stageIdx !== 0 || !stageData);
  }
  // Fingerprints "View" toggle (only on Stage 5): Spread (~40 anchors) vs All (every fingerprint).
  function updateFpBtn() {
    const b = $('fpModeBtn');
    b.classList.toggle('hidden', stageIdx !== 4);
    b.textContent = fpMode === 'all' ? '⇄ View: All' : '⇄ View: Spread';
  }
  // Distance from point (px,py) to segment (x1,y1)-(x2,y2), for clicking a fingerprint line.
  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  // Click a fingerprint (Spread view only): find the nearest pairing line and show its details.
  function inspectFingerprint(e) {
    const segs = stageData && stageData.fpSegments; if (!segs) return;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const nT = stageData.spec.numFrames, nB = stageData.spec.numBins, W = r.width, H = r.height;
    const PX = t => (t / nT) * W, PY = f => H - (f / nB) * H;
    let bestD = 9, best = null;
    for (const s of segs) {
      const dd = distToSeg(mx, my, PX(s.a.t), PY(s.a.f), PX(s.b.t), PY(s.b.f));
      if (dd < bestD) { bestD = dd; best = s; }
    }
    if (best) {
      const a = best.a, b = best.b, sr = stageData.sr, fs = D.CONFIG.frameSize, hop = D.CONFIG.hopSize, dt = b.t - a.t;
      stageData.fpSelected = {
        a, b, f1: Math.round(a.f * sr / fs), f2: Math.round(b.f * sr / fs),
        dtMs: Math.round(dt * hop / sr * 1000),
        hash: (((a.f & 0x1FF) << 23) | ((b.f & 0x1FF) << 14) | (dt & 0x3FFF)) >>> 0,
      };
    } else stageData.fpSelected = null;
    draw(1);
  }
  function showStage(i) {
    const wasStage0 = stageIdx === 0;
    stageIdx = Math.max(0, Math.min(STAGES.length - 1, i));
    if (wasStage0 && stageIdx !== 0) stopPlayback();
    updatePlayBtn(); updateFpBtn();
    canvas.style.cursor = (stageIdx === 0 || stageIdx === 1) ? 'ew-resize'
      : (stageIdx === 4 && fpMode === 'spread') ? 'crosshair' : 'default';
    $('caption').textContent = STAGES[stageIdx][1];
    subStep = 0;
    if (stageData) { stageData.fpMode = fpMode; stageData.fpSelected = null; stageData.subStep = 0; }
    renderTracker(); animateStage();
  }
  // Next/Prev advance an internal sub-step first (for stages that reveal in two presses), then the stage.
  function nextStep() {
    if (subStep < (STAGE_SUBSTEPS[stageIdx] || 1) - 1) { subStep++; if (stageData) stageData.subStep = subStep; animateStage(); }
    else showStage(stageIdx + 1);
  }
  function prevStep() {
    if (subStep > 0) { subStep--; if (stageData) stageData.subStep = subStep; animateStage(); }
    else showStage(stageIdx - 1);
  }
  // Return to the start screen so a new mode/song can be chosen without reloading the page.
  function goHome() {
    stopPlayback();
    IO.stopMic();
    cancelAnimationFrame(anim);
    stageData = null; stageIdx = 0;
    $('controls').classList.add('hidden');
    $('levelMeter').classList.add('hidden');
    $('homeBtn').classList.add('hidden');
    // Reset the live flow back to step 1 (mic released → must be re-enabled).
    $('recordBtn').classList.add('hidden');
    $('modeLive').classList.remove('hidden'); $('modeLive').disabled = false;
    $('status').textContent = db ? 'Ready ✓' : 'Preparing song database…';
    updatePlayBtn();
    $('caption').textContent = '';
    const [W, H] = dims(); ctx.clearRect(0, 0, W, H);
    renderTracker();
    $('start').classList.remove('hidden');
  }

  // Compute every artifact a renderer needs for the given recording PCM, up front.
  function precompute(pcm) {
    const spec = D.stft(pcm), peaks = D.findPeaks(spec), fps = D.fingerprint(peaks);
    const detail = D.matchDetail(fps, db);
    const results = detail.results, best = results[0], runnerUp = results[1];
    // Confident only if the winning spike clears the floor AND clearly stands out above the next song
    // (a genuine match spikes far above the scatter; noise/absent audio produces a low, flat field).
    const confident = !!(best && best.score >= D.CONFIG.minScore && best.score >= 3 * (runnerUp ? runnerUp.score : 0));
    const bestGuessSong = best ? (root.SONGS.find(s => s.id === best.songId) || null) : null;
    const matchedSong = confident ? bestGuessSong : null; // reveal a MATCH only when confident
    const focusFrame = Math.max(0, Math.floor(spec.numFrames / 2)); // slice Stage 2/3 share
    stageData = { pcm, sr: D.CONFIG.sampleRate, spec, peaks, fingerprints: fps, results, matchDetail: detail, songs: root.SONGS, matchedSong, bestGuessSong, confident, focusFrame };
  }
  function enterPipeline() {
    $('start').classList.add('hidden'); $('controls').classList.remove('hidden');
    $('homeBtn').classList.remove('hidden');
    showStage(0);
  }

  // Step 1 of the live flow: turn on the mic as its own action. This gets the one-time permission
  // prompt out of the way and — crucially — lets the mic/OS audio pipeline settle for a moment
  // BEFORE the timed recording, so its ~1-2 s warm-up glitch never lands inside the recording.
  // The mic's *actual* settings are shown so we can confirm the browser really disabled AGC etc.
  async function enableMicFlow() {
    $('modeLive').disabled = true;
    $('status').textContent = 'Enabling microphone…';
    try {
      const { settings } = await IO.enableMic();
      const b = v => v === undefined ? '?' : (v ? 'ON' : 'off');
      $('status').textContent = 'Mic ready ✓ — give it a second, then Record. ' +
        `(AGC ${b(settings.autoGainControl)}, echo-cancel ${b(settings.echoCancellation)}, ` +
        `noise-suppress ${b(settings.noiseSuppression)}` + (settings.sampleRate ? `, ${settings.sampleRate} Hz)` : ')');
      $('modeLive').classList.add('hidden');
      $('recordBtn').classList.remove('hidden');
    } catch (err) {
      $('modeLive').disabled = false;
      $('status').textContent = 'Microphone unavailable: ' + (err.name || err.message);
      alert('Microphone unavailable (' + (err.name || err.message) + '). Use Chrome/Edge and allow mic access, or use Canned playback.');
    }
  }

  // Diagnostic: print the recording's per-second RMS loudness so a mid-recording dropout is visible
  // as numbers in the console (open DevTools with F12). Also stashed on window.__recordingRMS.
  function logRecordingRMS(pcm, label) {
    const sr = D.CONFIG.sampleRate, secs = Math.max(1, Math.ceil(pcm.length / sr)), rows = [];
    for (let s = 0; s < secs; s++) {
      const a = s * sr, b = Math.min(pcm.length, a + sr); let sum = 0;
      for (let i = a; i < b; i++) sum += pcm[i] * pcm[i];
      rows.push(b > a ? Math.sqrt(sum / (b - a)) : 0);
    }
    const bar = v => { const k = Math.max(0, Math.min(24, Math.round(v * 480))); return '#'.repeat(k) + '.'.repeat(24 - k); };
    console.log(`%cLive recording (${label || 'raw'}) — RMS loudness per second:`, 'font-weight:bold');
    rows.forEach((v, i) => console.log(`  ${String(i).padStart(2)}s  ${v.toFixed(4)}  ${bar(v)}`));
    root['__recordingRMS_' + (label || 'raw')] = rows;
  }

  // --- Live mode: draw the waveform in real time while recording ---
  async function runLive() {
    stageData = null; // close the keyboard-gate gap: a stale prior stageData would let
                       // keypresses drive stages during this run's "Listening…" window
    $('start').classList.add('hidden'); $('controls').classList.add('hidden');
    stageIdx = 0; renderTracker();
    // Countdown + live input-level cue so the presenter/audience can see the mic is picking
    // up sound during the 10 s capture window.
    let remaining = 10;
    const setCaption = () => { $('caption').textContent = `Listening… play the song now. (${remaining}s)`; };
    setCaption();
    const countdown = setInterval(() => { remaining = Math.max(0, remaining - 1); setCaption(); }, 1000);
    $('levelMeter').classList.remove('hidden');
    const onLevel = level => {
      const v = Math.max(0, Math.min(1, level));
      const bar = $('levelBar'); bar.style.width = (v * 100) + '%'; bar.style.opacity = String(.35 + v * .65);
    };
    // Live recording waveform: a real sample LINE in the same style as the Stage 1 waveform, filling
    // left→right over the 10 s. Each poll appends a few samples at their elapsed-time position; those
    // points are fixed once placed, so the drawn history stays put (no reshuffling/flicker) and only
    // the right edge advances.
    const pts = []; let prevFrac = 0, t0 = null;
    const onWindow = w => {
      if (t0 === null) t0 = performance.now(); // clock starts at the first sample, not before mic setup
      const frac = Math.min(1, (performance.now() - t0) / 10000), K = 8;
      for (let k = 0; k < K; k++) pts.push({ f: prevFrac + (k / K) * (frac - prevFrac), v: w[Math.floor((k / K) * w.length)] || 0 });
      prevFrac = frac;
      const [W, H] = dims(); ctx.clearRect(0, 0, W, H);
      const mid = H / 2, amp = mid * 0.9;
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1; // faint centre line
      ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
      ctx.strokeStyle = '#4be0c0'; ctx.lineWidth = 1.5; ctx.beginPath(); // same look/colour as Renderers.waveform
      for (let i = 0; i < pts.length; i++) { const x = pts[i].f * W, y = mid + pts[i].v * amp; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
    };
    let pcm;
    try {
      // captureMicStreaming records via MediaRecorder and returns mono PCM at the DSP rate.
      pcm = await IO.captureMicStreaming(10, onWindow, onLevel);
    } finally {
      clearInterval(countdown);
      $('levelMeter').classList.add('hidden');
    }
    $('caption').textContent = 'Analysing…';
    logRecordingRMS(pcm, 'raw');            // diagnostic: shows the mic's droop/quietness
    pcm = IO.normalizeRecording(pcm);       // flatten the slow gain fade + lift quiet captures
    logRecordingRMS(pcm, 'normalized');     // diagnostic: should be flat + louder
    await dbReady;
    precompute(pcm);
    $('controls').classList.remove('hidden');
    $('homeBtn').classList.remove('hidden');
    showStage(0);
  }

  async function runCanned() {
    IO.stopMic(); // if the mic was enabled but we're going canned, release it so playback isn't ducked
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
    $('modeLive').onclick = () => enableMicFlow();
    $('recordBtn').onclick = () => runLive().catch(err => {
      $('start').classList.remove('hidden'); $('controls').classList.add('hidden');
      alert('Recording failed (' + (err.name || err.message) + '). Re-enable the microphone or use Canned playback.');
    });
    $('fsBtn').onclick = () => document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    $('playBtn').onclick = () => {
      if (!stageData) return;
      if (playSource) { stopPlayback(); return; }
      playSource = IO.makeSource(stageData.pcm, stageData.sr);
      playSource.play();
      $('playBtn').textContent = '■ Stop clip';
      startPlayheadLoop();
    };
    $('homeBtn').onclick = () => goHome();
    $('fpModeBtn').onclick = () => { fpMode = (fpMode === 'spread') ? 'all' : 'spread'; showStage(stageIdx); };
    $('nextBtn').onclick = () => nextStep();
    $('prevBtn').onclick = () => prevStep();
    $('replayBtn').onclick = () => animateStage();
    document.addEventListener('keydown', e => {
      if (!$('start').classList.contains('hidden')) return; // ignore keys on start screen
      if (!stageData) return; // ignore keys before precompute finishes (e.g. during live listening)
      if (e.code === 'Space' || e.code === 'ArrowRight') { e.preventDefault(); nextStep(); }
      else if (e.code === 'ArrowLeft') prevStep();
      else if (e.key.toLowerCase() === 'r') animateStage();
    });
    // Interactive slice selection: drag on the waveform (Stage 1) or the Fourier minimap
    // (Stage 2) to move which ~93 ms slice gets analysed.
    let dragging = false;
    const SLICE_PAD = 40; // must match the `pad` used in Renderers.fourier's minimap
    function frameFromEvent(e) {
      if (!stageData) return null;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const n = stageData.pcm.length, maxF = stageData.spec.numFrames - 1;
      let frac;
      if (stageIdx === 0) {
        frac = x / r.width;                          // waveform spans the full width
      } else if (stageIdx === 1) {
        if (y > r.height * 0.16 + 20) return null;   // only the minimap band is draggable
        frac = (x - SLICE_PAD) / (r.width - 2 * SLICE_PAD);
      } else return null;
      frac = Math.max(0, Math.min(1, frac));
      return Math.max(0, Math.min(maxF, Math.round(frac * n / D.CONFIG.hopSize)));
    }
    function applyFocus(e) {
      const f = frameFromEvent(e);
      if (f == null || !stageData || f === stageData.focusFrame) return;
      stageData.focusFrame = f; draw(1);
    }
    canvas.addEventListener('mousedown', e => {
      if ((stageIdx === 0 || stageIdx === 1) && stageData) { dragging = true; cancelAnimationFrame(anim); applyFocus(e); }
      else if (stageIdx === 4 && fpMode === 'spread' && stageData) { inspectFingerprint(e); } // click a fingerprint
    });
    canvas.addEventListener('mousemove', e => { if (dragging) applyFocus(e); });
    window.addEventListener('mouseup', () => { dragging = false; });
    canvas.addEventListener('mouseleave', () => { dragging = false; });
    window.addEventListener('resize', resize);
    resize();
  }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initUI);

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
