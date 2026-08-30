// worker.js — runs inside the Web Worker. dsp.js is prepended by the build, so self.DSP exists.
// Fingerprinting (many FFTs) is CPU-heavy; doing it here keeps the UI responsive.
self.onmessage = function (e) {
  const { id, pcm } = e.data;
  const D = self.DSP;
  const fingerprints = D.fingerprint(D.findPeaks(D.stft(pcm)));
  self.postMessage({ id, fingerprints });
};
