# How Shazam Works — Live Demo

A single self-contained HTML file that walks through Shazam's recognition pipeline
and matches a song (live mic or canned clip) against the embedded tracks.

## Build
1. Put MP3s in `./songs/`, named `Artist - Song title.mp3` (5–10 recommended).
2. `npm run build` → produces `shazam-demo.html`.

## Run the demo
- Double-click `shazam-demo.html` (opens in your browser, fully offline).
- **Use Chrome or Edge for the live-mic path** (Safari often blocks mic on file://).
- Wait for "Ready ✓" on the start screen (songs are analysed in the background).
- **Canned playback:** pick a song, click ▶. **Live:** click 🎤, play the song into the mic for 10s
  (the waveform draws in real time as it records).
- Space / → = next stage, ← = previous, R = replay animation, ⛶ = fullscreen.

## Documentation
Open `docs/how-it-works.html` for a full explanation of the concepts and the code.

## Rehearsal checklist
- [ ] Grant mic permission once in the presentation browser.
- [ ] Confirm a live recording of a DB song lands the correct match.
- [ ] Have canned playback ready as the fallback.

## Test the DSP core
`npm test`

## Swap songs
Replace files in `./songs/`, re-run `npm run build`. Many full songs make a larger file
and a slower first-load analysis; ~5–10 is the sweet spot.
