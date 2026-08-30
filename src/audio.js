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
