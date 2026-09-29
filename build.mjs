// build.mjs — bakes all source + the songs into one self-contained shazam-demo.html.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SONGS_DIR = process.env.SONGS_DIR || 'songs'; // e.g. SONGS_DIR=songs-web for a smaller hosted build
const OUT = process.env.OUT || 'shazam-demo.html';  // e.g. OUT=dist-web/index.html for the hosted deploy
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

// --- Album art -------------------------------------------------------------------------------------
// Look each song up on the iTunes Search API at build time and embed the album thumbnail as a data
// URI, so the demo stays fully offline at run time (no CORS, no network needed to present). Results
// are cached in art-cache.json (gitignored) to keep rebuilds fast and offline. A miss just leaves
// art:null and the UI falls back to a coloured placeholder.
const ART_CACHE = 'art-cache.json';
let artCache = {};
try { artCache = JSON.parse(readFileSync(ART_CACHE, 'utf8')); } catch {}

async function fetchWithTimeout(url, ms) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal }); } finally { clearTimeout(timer); }
}
async function fetchArt(artist, title) {
  const term = encodeURIComponent(`${artist} ${title}`.trim());
  const res = await fetchWithTimeout(`https://itunes.apple.com/search?term=${term}&entity=song&limit=1`, 8000);
  const found = (await res.json()).results?.[0];
  if (!found?.artworkUrl100) return null;
  const img = await fetchWithTimeout(found.artworkUrl100.replace('100x100bb', '300x300bb'), 8000);
  const buf = Buffer.from(await img.arrayBuffer());
  return `data:${img.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
}

let embedded = 0, missing = 0;
for (const s of songs) {
  const key = `${s.artist} - ${s.title}`;
  if (key in artCache) { s.art = artCache[key]; }
  else {
    try { s.art = await fetchArt(s.artist, s.title); }
    catch (e) { s.art = null; console.warn(`  album art error for "${key}": ${e.message}`); }
    if (!s.art) console.warn(`  no album art found for "${key}"`);
    artCache[key] = s.art || null;
  }
  s.art ? embedded++ : missing++;
}
try { writeFileSync(ART_CACHE, JSON.stringify(artCache)); } catch {}
console.log(`Album art: ${embedded} embedded${missing ? `, ${missing} missing (placeholder)` : ''}`);

const read = p => readFileSync(p, 'utf8');
// The worker script = dsp.js (defines self.DSP) + worker.js handler, embedded as a JS string.
const workerSource = read('src/dsp.js') + '\n' + read('src/worker.js');
const bundle = [read('src/dsp.js'), read('src/audio.js'), read('src/renderers.js'), read('src/controller.js')].join('\n\n');

// Defensive: a literal "</script" inside embedded content would prematurely close the
// <script> tag it's injected into. None of our sources/base64 contain it today, but escape
// it anyway so the build can never produce a broken page. Applied to the individual pieces
// being embedded (not the final HTML), so the real closing </script> tags are untouched.
const escapeScriptClose = s => s.replace(/<\/script/gi, '<\\/script');

const html = read('src/template.html')
  .replace('/*__STYLES__*/', () => read('src/styles.css'))
  .replace('/*__SONGS__*/', () => 'var SONGS=' + escapeScriptClose(JSON.stringify(songs)) + ';')
  .replace('/*__WORKER__*/', () => 'var WORKER_SOURCE=' + escapeScriptClose(JSON.stringify(workerSource)) + ';')
  .replace('/*__SCRIPT__*/', () => escapeScriptClose(bundle));

writeFileSync(OUT, html);
const mb = (Buffer.byteLength(html) / 1048576).toFixed(1);
console.log(`Built ${OUT} — ${songs.length} songs, ${mb} MB`);
if (mb > 60) console.warn(`WARNING: ${mb} MB is large; consider fewer songs for faster load.`);
