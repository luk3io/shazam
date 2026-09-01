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
- **Canned playback:** pick a song, click ▶.
- **Live:** click 🎤 **Enable microphone**; once it reads "Mic ready ✓", click ● **Record & identify**
  and play the song for ~10s — the waveform draws in real time. Enabling the mic as its own step lets it
  settle first, so the start of the recording isn't clipped.
- **Even out recording volume** (start-screen toggle, on by default) evens out a quiet or uneven mic
  capture. It's cosmetic — it changes how the clip sounds/looks, not the match.
- **▶ Play clip** (on the waveform and Fourier stages) plays your recording back; on the Fourier stage the
  analysed slice follows the playhead, so its frequency breakdown updates in time with the audio.
- Space / → = next stage, ← = previous, R = replay animation, ⛶ = fullscreen.

## Documentation
- `docs/how-it-works.html` — **the concepts:** what the algorithm does and why, with analogies (presenter-facing).
- `docs/code-guide.md` — **the codebase:** how it's wired, the end-to-end data flow, and where to change things (developer-facing).

## Rehearsal checklist
- [ ] Click **Enable microphone** and grant permission (browsers re-ask on every `file://` load); wait for "Mic ready ✓".
- [ ] Confirm a live recording of a DB song lands the correct match.
- [ ] Have canned playback ready as the fallback.

## Test the DSP core
`npm test`

## Swap songs
Replace files in `./songs/`, re-run `npm run build`. Many full songs make a larger file
and a slower first-load analysis; ~5–10 is the sweet spot.
