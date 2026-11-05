---
name: deploy
description: Use when deploying, publishing, shipping, or pushing the Shazam demo site live to Cloudflare Pages (luke-shazammer) — the manual build + wrangler upload that CI deliberately cannot do.
---

# Deploy the Shazam demo to Cloudflare Pages

## Overview

The site is a single `index.html` with every song base64-embedded, built from
the shrunk `songs-web/` copies. The audio is copyrighted and gitignored, so it
only exists on your machine — **CI cannot and will not deploy** (see
`.github/workflows/test.yml`, which runs tests only). Deploy is always a local,
manual step via `npm run deploy` (`deploy.mjs`).

## Prerequisites (one-time)

1. **Cloudflare login:** `npx wrangler login` — opens a browser, authorizes once,
   persists locally. If you need the user to run this interactively, suggest they
   type `! npx wrangler login` in the prompt.
2. **`songs-web/` populated** with shrunk mono/64k MP3s. To create one from a
   full song (needs `ffmpeg`):
   ```
   ffmpeg -y -i "songs/NAME.mp3" -ac 1 -b:a 64k "songs-web/NAME.mp3"
   ```

## First-time project setup (once per Cloudflare account)

The Pages project must already exist, or deploy fails with
`The Pages project "luke-shazammer" does not exist.` Create it once:

```
npx wrangler pages project create luke-shazammer --production-branch=main --force
```

`--force` is required **only here**: current wrangler (4.x) otherwise delegates
`pages` commands to the newer Workers flow, which fails for a project that
doesn't exist yet. `--force` creates it directly on classic Pages. Once the
project exists, drop `--force` — `npm run deploy` and all later commands run
against Pages directly. The site then lives at `https://luke-shazammer.pages.dev`.

## Deploy

```
npm run deploy
```

This runs `deploy.mjs`, which:
1. Checks `songs-web/` has at least one `.mp3` (errors out with the ffmpeg hint if not).
2. Builds `dist-web/index.html` from `songs-web/` (via `build.mjs` with
   `SONGS_DIR=songs-web OUT=dist-web/index.html` — your local `shazam-demo.html`
   is left untouched).
3. Runs `npx wrangler pages deploy dist-web --project-name luke-shazammer --commit-dirty=true`.

Nothing touches git — the copyrighted audio stays out of the repo.

## Quick reference

| Need | Do |
|------|----|
| Deploy now | `npm run deploy` |
| Deploy to a different Pages project | `CF_PROJECT=other-name npm run deploy` |
| Rebuild local demo only (no deploy) | `npm run build` → `shazam-demo.html` |
| Re-auth Cloudflare | `npx wrangler login` |

## Common mistakes

- **`No MP3s in ./songs-web/`** — you haven't created the shrunk copies. Run the
  `ffmpeg` command above for each song.
- **wrangler prompts to log in / 401** — run `npx wrangler login` first.
- **`The Pages project "luke-shazammer" does not exist.`** — first-time setup
  wasn't done. Run the `wrangler pages project create … --force` command above once.
- **Trying to make CI deploy** — don't. The audio is gitignored, so a GitHub
  Action has nothing to build. Deploy is intentionally local-only.
- **Editing `dist-web/` by hand** — it's generated; change `src/` or `songs-web/`
  and redeploy.
