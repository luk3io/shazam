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
  const $ = id => document.getElementById(id);
  let canvas, ctx, stageData = null, db = null, dbReady = null, stageIdx = 0, anim = null, playSource = null, playAnim = null;

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
  function showStage(i) {
    const wasStage0 = stageIdx === 0;
    stageIdx = Math.max(0, Math.min(STAGES.length - 1, i));
    if (wasStage0 && stageIdx !== 0) stopPlayback();
    updatePlayBtn();
    canvas.style.cursor = (stageIdx === 0 || stageIdx === 1) ? 'ew-resize' : 'default'; // slice is draggable
    $('caption').textContent = STAGES[stageIdx][1];
    renderTracker(); animateStage();
  }
  // Return to the start screen so a new mode/song can be chosen without reloading the page.
  function goHome() {
    stopPlayback();
    cancelAnimationFrame(anim);
    stageData = null; stageIdx = 0;
    $('controls').classList.add('hidden');
    $('levelMeter').classList.add('hidden');
    $('homeBtn').classList.add('hidden');
    updatePlayBtn();
    $('caption').textContent = '';
    const [W, H] = dims(); ctx.clearRect(0, 0, W, H);
    renderTracker();
    $('start').classList.remove('hidden');
  }

  // Compute every artifact a renderer needs for the given recording PCM, up front.
  function precompute(pcm) {
    const spec = D.stft(pcm), peaks = D.findPeaks(spec), fps = D.fingerprint(peaks);
    const results = D.matchQuery(fps, db);
    const best = results[0];
    const matchedSong = (best && best.score >= D.CONFIG.minScore)
      ? (root.SONGS.find(s => s.id === best.songId) || null) : null;
    const focusFrame = Math.max(0, Math.floor(spec.numFrames / 2)); // slice Stage 2/3 share
    stageData = { pcm, sr: D.CONFIG.sampleRate, spec, peaks, fingerprints: fps, results, songs: root.SONGS, matchedSong, focusFrame };
  }
  function enterPipeline() {
    $('start').classList.add('hidden'); $('controls').classList.remove('hidden');
    $('homeBtn').classList.remove('hidden');
    showStage(0);
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
    // Live visual buffer: draw raw mic samples as they arrive (shape only — no resampling).
    // Sized for the worst-case native mic rate so it never overflows during the 10 s capture.
    const live = new Float32Array(48000 * 11); let filled = 0;
    const onChunk = chunk => {
      for (let i = 0; i < chunk.length && filled < live.length; i++) live[filled++] = chunk[i];
      const [W, H] = dims(); ctx.clearRect(0, 0, W, H);
      root.Renderers.waveform(ctx, { pcm: live.subarray(0, filled) }, 1, W, H); // maps across full width
    };
    let pcm;
    try {
      // captureMicStreaming returns the recording correctly resampled to the DSP rate.
      pcm = await IO.captureMicStreaming(10, onChunk, onLevel);
    } finally {
      clearInterval(countdown);
      $('levelMeter').classList.add('hidden');
    }
    $('caption').textContent = 'Analysing…';
    await dbReady;
    precompute(pcm);
    $('controls').classList.remove('hidden');
    $('homeBtn').classList.remove('hidden');
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
    $('modeLive').onclick = () => runLive().catch(err => {
      $('start').classList.remove('hidden'); $('controls').classList.add('hidden');
      alert('Microphone unavailable (' + err.name + '). Use Chrome/Edge, allow mic access, or use Canned playback.');
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
    $('nextBtn').onclick = () => showStage(stageIdx + 1);
    $('prevBtn').onclick = () => showStage(stageIdx - 1);
    $('replayBtn').onclick = () => animateStage();
    document.addEventListener('keydown', e => {
      if (!$('start').classList.contains('hidden')) return; // ignore keys on start screen
      if (!stageData) return; // ignore keys before precompute finishes (e.g. during live listening)
      if (e.code === 'Space' || e.code === 'ArrowRight') { e.preventDefault(); showStage(stageIdx + 1); }
      else if (e.code === 'ArrowLeft') showStage(stageIdx - 1);
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
