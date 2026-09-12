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
    // Clamp the start so a short track (durSec longer than what's left) still yields the
    // available tail instead of an empty slice; long songs (today's 5) are unaffected.
    const maxStart = Math.max(0, pcm.length / sr - durSec);
    const startClamped = Math.min(startSec, maxStart);
    const a = Math.floor(startClamped * sr), b = Math.min(pcm.length, a + Math.floor(durSec * sr));
    return pcm.slice(a, b);
  }

  // --- Microphone ---
  // The whole capture pipeline is built ONCE by enableMic() and kept warm & running: the mic stream,
  // an AudioContext, a MediaStreamSource, an AnalyserNode for the live meter, and a silent keep-alive.
  // Recording (captureMicStreaming) then only attaches a MediaRecorder to the already-settled stream.
  //
  // Why warm it up first: when the mic first opens, Windows/Chrome spend ~1-2 s reconfiguring the
  // audio pipeline (device warm-up, echo-cancel/AGC negotiation), during which the captured audio
  // briefly drops to silence and then recovers. If recording started at that moment, the dropout
  // landed inside the recording (the reported "silent for ~1 s near the start" bug). By enabling the
  // mic as a separate step, that settling happens BEFORE the timed window, so the recording is clean.
  let mic = null; // { stream, ac, srcNode, analyser, keepAlive, win }

  // Acquire the mic. We leave automatic gain control ON: the demo captures a song playing across the
  // room from a separate device, which reaches the mic very quietly, and AGC boosts that to a usable
  // level *at capture* — far cleaner than amplifying a near-noise-floor recording afterward. (AGC was
  // originally disabled to chase a mid-recording dropout, but that turned out to be the mic warm-up
  // glitch, which enabling the mic as a separate step now handles.) Echo cancellation and noise
  // suppression stay OFF — they're tuned for speech and distort/gate music. getSettings() is returned
  // so the caller can show what the browser actually applied.
  async function enableMic() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    const Ctx = root.AudioContext || root.webkitAudioContext;
    const ac = new Ctx();
    if (ac.state === 'suspended' && ac.resume) { try { await ac.resume(); } catch (e) {} }
    const srcNode = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0;
    srcNode.connect(analyser); // NOTE: analyser is NOT connected onward — the mic never reaches an output.
    // Keep the context rendering (so the analyser keeps updating) WITHOUT routing the mic to the
    // destination — a DC source at zero gain, independent of the mic. Routing the mic itself toward an
    // output can flip Windows/Chrome into "communications" processing that silences a loud input.
    let keepAlive = null;
    try {
      keepAlive = ac.createConstantSource();
      const ka = ac.createGain(); ka.gain.value = 0;
      keepAlive.connect(ka); ka.connect(ac.destination); keepAlive.start();
    } catch (e) { keepAlive = null; } // ConstantSourceNode unavailable: analyser usually still updates
    mic = { stream, ac, srcNode, analyser, keepAlive, win: new Float32Array(analyser.fftSize) };
    const track = stream.getAudioTracks()[0];
    return { settings: track && track.getSettings ? track.getSettings() : {} };
  }
  function stopMic() {
    if (!mic) return;
    try { if (mic.keepAlive) mic.keepAlive.stop(); mic.srcNode.disconnect(); mic.analyser.disconnect(); mic.ac.close(); } catch (e) {}
    mic.stream.getTracks().forEach(t => t.stop());
    mic = null;
  }

  // Record `seconds` from the warm mic pipeline (enableMic must have run). The authoritative audio is
  // captured with MediaRecorder tapping the MediaStream track directly; the live waveform/level is
  // read from the already-running AnalyserNode. onWindow receives the current time-domain window.
  async function captureMicStreaming(seconds, onWindow, onLevel) {
    if (!mic) throw Object.assign(new Error('microphone not enabled'), { name: 'NotReadableError' });
    const { stream, analyser, win } = mic;
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t));
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const blobs = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) blobs.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });
    // Poll on a timer, NOT requestAnimationFrame: rAF gets throttled/paused in some situations
    // (which froze the live meter). setInterval keeps updating reliably in the foreground.
    const poll = () => {
      analyser.getFloatTimeDomainData(win);
      if (onWindow) onWindow(win);
      if (onLevel) { let pk = 0; for (let i = 0; i < win.length; i++) { const a = Math.abs(win[i]); if (a > pk) pk = a; } onLevel(pk); }
    };
    rec.start(1000); const timer = setInterval(poll, 40); poll(); // flush the recording every second
    // Wait the full window, but let cancelCapture() end it early (e.g. Stop pressed before the song).
    let cancelled = false;
    await new Promise(res => {
      const finish = () => { clearTimeout(to); cancelCurrent = null; res(); };
      const to = setTimeout(finish, seconds * 1000);
      cancelCurrent = () => { cancelled = true; finish(); };
    });
    clearInterval(timer);
    try { rec.stop(); } catch (e) {}
    await stopped;
    // Release the mic the instant recording ends. While a mic is open, Windows keeps the audio
    // session in "communications" mode and DUCKS other output — which silenced the Play-clip
    // playback during the stages. We already have the recorded blob, so the mic is no longer needed.
    stopMic();
    if (cancelled) throw Object.assign(new Error('recording cancelled'), { name: 'AbortError' });
    return decodeToMono(await new Blob(blobs).arrayBuffer()); // decode the recording -> mono PCM @ DSP rate
  }
  // Set while a capture is in flight; call cancelCapture() to end the current recording early.
  let cancelCurrent = null;
  function cancelCapture() { if (cancelCurrent) cancelCurrent(); }

  // Even up a recording's loudness over time so a mic that fades on a sustained song (Windows driver
  // AGC, which we can't disable from JS) and a generally-quiet capture both come back to a consistent,
  // audible level. We target a constant short-time RMS: divide each moment by its smoothed RMS envelope
  // (a ~0.4 s window) toward a target level. RMS (not peak) means slow fades are flattened without the
  // gain chasing transient clicks — that click-chasing is what made an earlier peak-based version sound
  // scratchy. A per-sample hard limit prevents clipping. Purely cosmetic/audible: the fingerprint
  // peak-picker is per-frame relative, so matching is unaffected.
  function normalizeRecording(pcm) {
    const n = pcm.length;
    if (!n) return pcm;
    const sr = SR(), targetRMS = 0.14, maxGain = 10, ceiling = 0.97;
    const winSamp = Math.max(1, Math.floor(0.4 * sr)); // ~0.4 s smoothing window
    const hop = Math.max(1, Math.floor(winSamp / 8)), nb = Math.ceil(n / hop);
    // Short-time RMS envelope (each block averages over ~winSamp centred-ish on the block start).
    const rms = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      const a0 = b * hop, a1 = Math.min(n, a0 + winSamp); let s = 0, c = 0;
      for (let i = a0; i < a1; i++) { s += pcm[i] * pcm[i]; c++; }
      rms[b] = c ? Math.sqrt(s / c) : 0;
    }
    let maxR = 0; for (let b = 0; b < nb; b++) if (rms[b] > maxR) maxR = rms[b];
    if (maxR === 0) return pcm.slice(); // pure silence: nothing to lift
    const floor = Math.max(maxR * 0.12, 1e-4); // don't boost near-silence to full target
    // Per-sample gain = min(maxGain, targetRMS / envRMS), interpolated between block centres; hard-limited.
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const bf = i / hop, b0 = Math.min(nb - 1, Math.floor(bf)), b1 = Math.min(nb - 1, b0 + 1), f = bf - b0;
      const e = Math.max(floor, rms[b0] + (rms[b1] - rms[b0]) * f);
      let v = pcm[i] * Math.min(maxGain, targetRMS / e);
      out[i] = v > ceiling ? ceiling : (v < -ceiling ? -ceiling : v);
    }
    return out;
  }

  // A playable clip that supports pause/resume. A BufferSource can't be paused, so pausing records the
  // offset and stops the node; resuming starts a fresh node from that offset (start(0, offset)).
  function makeSource(pcm, sr = SR()) {
    const Ctx = root.AudioContext || root.webkitAudioContext;
    const dur = pcm.length / sr;
    let ac = null, node = null, startedAt = 0, offset = 0, playing = false, ended = false;
    function ensureCtx() {
      if (!ac) ac = new Ctx();
      // A freshly created AudioContext can start "suspended" under the browser's autoplay policy;
      // resume() (safe to call from a click handler) makes it audible.
      if (ac.state === 'suspended' && ac.resume) ac.resume();
    }
    function startAt(off) {
      ensureCtx();
      const b = ac.createBuffer(1, pcm.length, sr); b.copyToChannel(pcm, 0);
      node = ac.createBufferSource(); node.buffer = b; node.connect(ac.destination);
      node.onended = () => { if (playing) { playing = false; ended = true; offset = 0; } }; // natural end
      startedAt = ac.currentTime - off; node.start(0, off); playing = true; ended = false;
    }
    function stopNode() { if (node) { node.onended = null; try { node.stop(); } catch (e) {} node = null; } }
    return {
      duration: dur,
      play() { offset = 0; startAt(0); },                                    // (re)start from the beginning
      resume() { if (playing) return; if (offset >= dur - 0.01) offset = 0; startAt(offset); }, // continue
      pause() { if (!playing) return; offset = Math.min(dur, ac.currentTime - startedAt); stopNode(); playing = false; },
      elapsed() { return playing && ac ? Math.max(0, ac.currentTime - startedAt) : offset; }, // seconds in
      isPlaying() { return playing; },
      isEnded() { return ended; },
      stop() { stopNode(); try { ac && ac.close(); } catch (e) {} ac = null; playing = false; ended = true; offset = 0; },
    };
  }

  root.AudioIO = { base64ToArrayBuffer, decodeToMono, sliceSeconds, resampleLinear, enableMic, stopMic, captureMicStreaming, cancelCapture, normalizeRecording, makeSource };
})(typeof self !== 'undefined' ? self : this);
