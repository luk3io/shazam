// deploy.mjs — build the hosted (small) version and push it to Cloudflare Pages in one step.
// Run locally with `npm run deploy` (the machine that has songs-web/ and your Cloudflare login).
//   1. one-time:  npx wrangler login
//   2. every deploy:  npm run deploy
// Nothing here touches git — the copyrighted audio stays out of the repo. It builds straight into
// dist-web/index.html from the shrunk songs-web/ folder, then uploads that folder to Cloudflare Pages.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';

const PROJECT = process.env.CF_PROJECT || 'luke-shazammer'; // Cloudflare Pages project name
const SONGS = 'songs-web';

if (!existsSync(SONGS) || readdirSync(SONGS).filter(f => f.toLowerCase().endsWith('.mp3')).length === 0) {
  console.error(`No MP3s in ./${SONGS}/. Create the shrunk copies first (needs ffmpeg), e.g. per song:`);
  console.error(`  ffmpeg -y -i "songs/NAME.mp3" -ac 1 -b:a 64k "${SONGS}/NAME.mp3"`);
  process.exit(1);
}

mkdirSync('dist-web', { recursive: true });
console.log(`Building hosted version (${SONGS}) → dist-web/index.html …`);
execSync('node build.mjs', { stdio: 'inherit', env: { ...process.env, SONGS_DIR: SONGS, OUT: 'dist-web/index.html' } });

console.log(`\nDeploying to Cloudflare Pages (project: ${PROJECT}) …`);
execSync(`npx wrangler pages deploy dist-web --project-name ${PROJECT} --commit-dirty=true`, { stdio: 'inherit' });
