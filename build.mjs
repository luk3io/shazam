// build.mjs — bakes all source + the songs into one self-contained shazam-demo.html.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SONGS_DIR = 'songs';
const files = readdirSync(SONGS_DIR).filter(f => f.toLowerCase().endsWith('.mp3')).sort();
if (files.length === 0) throw new Error('No .mp3 files in ./songs');

// Parse "Artist - Title.mp3" and base64-encode the full song.
const songs = files.map((f, i) => {
  const base = f.replace(/\.mp3$/i, ''), parts = base.split(' - ');
  const artist = parts.length > 1 ? parts[0].trim() : 'Unknown';
  const title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : base;
  return { id: 's' + i, artist, title, mime: 'audio/mpeg',
    data: readFileSync(join(SONGS_DIR, f)).toString('base64') };
});

const read = p => readFileSync(p, 'utf8');
// The worker script = dsp.js (defines self.DSP) + worker.js handler, embedded as a JS string.
const workerSource = read('src/dsp.js') + '\n' + read('src/worker.js');
const bundle = [read('src/dsp.js'), read('src/audio.js'), read('src/renderers.js'), read('src/controller.js')].join('\n\n');

const html = read('src/template.html')
  .replace('/*__STYLES__*/', () => read('src/styles.css'))
  .replace('/*__SONGS__*/', () => 'var SONGS=' + JSON.stringify(songs) + ';')
  .replace('/*__WORKER__*/', () => 'var WORKER_SOURCE=' + JSON.stringify(workerSource) + ';')
  .replace('/*__SCRIPT__*/', () => bundle);

writeFileSync('shazam-demo.html', html);
const mb = (Buffer.byteLength(html) / 1048576).toFixed(1);
console.log(`Built shazam-demo.html — ${songs.length} songs, ${mb} MB`);
if (mb > 60) console.warn(`WARNING: ${mb} MB is large; consider fewer songs for faster load.`);
