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
    $('modeLive').onclick = () => runLive().catch(err => {
      $('start').classList.remove('hidden'); $('controls').classList.add('hidden');
      alert('Microphone unavailable (' + err.name + '). Use Chrome/Edge, allow mic access, or use Canned playback.');
    });
    $('fsBtn').onclick = () => document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
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
