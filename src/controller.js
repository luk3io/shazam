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
