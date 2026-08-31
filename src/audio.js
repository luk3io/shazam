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

  // Record from the mic, streaming blocks to onChunk for live drawing. Resolves with the
  // full recording resampled to the DSP rate.
  // Record from the mic. The authoritative recording is captured with MediaRecorder (which taps the
  // MediaStream directly and reliably records the full window), while a live waveform/level is driven
  // from an AnalyserNode. We deliberately avoid ScriptProcessorNode: with a live mic it stops
  // delivering audio after ~0.5 s in Chrome (the recording goes flat while the buffer keeps redrawing).
  // onWindow receives the current time-domain window (Float32Array) each animation frame.
  async function captureMicStreaming(seconds, onWindow, onLevel) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    // Authoritative recording via MediaRecorder (independent of the Web Audio graph).
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t));
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const blobs = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) blobs.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });
    // Live waveform + level via AnalyserNode (reliable across the whole capture).
    const Ctx = root.AudioContext || root.webkitAudioContext;
    const ac = new Ctx();
    if (ac.state === 'suspended' && ac.resume) { try { await ac.resume(); } catch (e) {} }
    const srcNode = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0;
    srcNode.connect(analyser);
    // Keep the context's graph active: an AnalyserNode with no path to the destination gets
    // suspended by the browser after a few seconds (freezing the live meter). Route it through a
    // muted gain so it stays running without anything being heard.
    const keepAlive = ac.createGain(); keepAlive.gain.value = 0;
    analyser.connect(keepAlive); keepAlive.connect(ac.destination);
    const win = new Float32Array(analyser.fftSize);
    let raf = 0;
    const poll = () => {
      if (ac.state === 'suspended' && ac.resume) ac.resume(); // re-wake if the browser suspended it
      analyser.getFloatTimeDomainData(win);
      if (onWindow) onWindow(win);
      if (onLevel) { let pk = 0; for (let i = 0; i < win.length; i++) { const a = Math.abs(win[i]); if (a > pk) pk = a; } onLevel(pk); }
      raf = requestAnimationFrame(poll);
    };
    rec.start(1000); poll(); // flush the recording every second so a mid-capture hiccup loses ≤1s
    await new Promise(r => setTimeout(r, seconds * 1000));
    cancelAnimationFrame(raf);
    rec.stop(); await stopped;
    try { srcNode.disconnect(); ac.close(); } catch (e) {}
    stream.getTracks().forEach(t => t.stop());
    return decodeToMono(await new Blob(blobs).arrayBuffer()); // decode the recording -> mono PCM @ DSP rate
  }

  function makeSource(pcm, sr = SR()) {
    const Ctx = root.AudioContext || root.webkitAudioContext;
    let ac = null, node = null, startedAt = 0, ended = false;
    return {
      duration: pcm.length / sr,
      play() {
        ac = new Ctx();
        // A freshly created AudioContext can start "suspended" under the browser's
        // autoplay policy; resume() (safe to call from the click handler) makes it audible.
        if (ac.state === 'suspended' && ac.resume) ac.resume();
        const b = ac.createBuffer(1, pcm.length, sr);
        b.copyToChannel(pcm, 0);
        node = ac.createBufferSource(); node.buffer = b;
        node.onended = () => { ended = true; };
        node.connect(ac.destination); startedAt = ac.currentTime; node.start();
      },
      elapsed() { return ac ? Math.max(0, ac.currentTime - startedAt) : 0; }, // seconds played
      isEnded() { return ended; },
      stop() { try { node && node.stop(); ac && ac.close(); } catch (e) {} ended = true; },
    };
  }

  root.AudioIO = { base64ToArrayBuffer, decodeToMono, sliceSeconds, resampleLinear, captureMicStreaming, makeSource };
})(typeof self !== 'undefined' ? self : this);
