// serve.mjs — zero-dependency static server for the built demo.
// Run `npm run serve`, then open the printed URL (http://localhost:8000/).
// Serving over http://localhost (rather than opening the file directly) is the reliable way to get
// the persistent fingerprint cache (IndexedDB) and avoids file:// quirks.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT || 8000;
const ROOT = dirname(fileURLToPath(import.meta.url)); // the repo folder, wherever this script lives
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.ico': 'image/x-icon', '.map': 'application/json',
};

createServer(async (req, res) => {
  let path = decodeURIComponent((req.url || '/').split('?')[0]);
  if (path === '/' || path === '') path = '/shazam-demo.html'; // default to the demo
  const file = resolve(ROOT, '.' + path);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; } // no path traversal
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(path === '/shazam-demo.html' ? 'shazam-demo.html not found — run `npm run build` first.' : 'Not found');
  }
}).listen(PORT, () => console.log(`Serving ${ROOT}\n→ http://localhost:${PORT}/   (Ctrl+C to stop)`));
