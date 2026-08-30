# Shazam Pipeline Demo — Design Spec

**Date:** 2026-08-30
**Purpose:** An interactive, projector-friendly visual tool for a school presentation that walks an audience through the six stages of Shazam's traditional music-recognition pipeline, ending in a live match. Runs as a companion to the slides at slide 6 ("Live Demo").

## Goals

- Visually teach the Shazam pipeline: waveform → Fourier transform → spectrogram → peak detection → fingerprints → matching.
- Be trivially easy to run under time pressure: no install, no command line, no internet.
- Cross-platform: one file that works on both Windows and Mac.
- Support a **live** demo (record a song played into the room via mic and detect it) and a **canned** fallback (deterministic bundled clip).
- The demo "does the teaching": one large animated stage at a time, driven by the presenter's narration.

## Non-Goals (out of scope)

- The AI/embeddings and vector-search sections (slides 7–8) — separate topic.
- A real or large-scale song database — the local DB holds 5 songs only.
- Synthetic noise injection — the live-mic path is the real-world/noise demonstration; canned stays clean. No noise toggle.
- Any server, backend, or network dependency.

## Constraints

- **Delivery:** a single self-contained `.html` file, opened by double-click (`file://`). Fully offline.
- **No external libraries** — everything (including the FFT) is hand-written vanilla JS so nothing needs to load.
- **Tech:** HTML + Canvas 2D + Web Audio API.
- **Live mic caveat:** `getUserMedia` from a `file://` page is reliable in **Chrome/Edge** (treated as a secure context) but **often blocked by Safari on Mac**. Recommendation: present the live path in Chrome/Edge. Canned works in all browsers. Mic permission is granted once during rehearsal and the live match is verified before the day.

## User Experience

### Start screen
Dark, high-contrast, large text, minimal chrome, a **Fullscreen** button. Two large mode buttons:

- **Live (mic):** shows a **Listen** button. On press, records ~10 s from the mic with a live input-level meter and a countdown. On completion, precomputes the pipeline for the captured clip (~1 s) and advances to Stage 1.
- **Canned playback:** a dropdown to choose one of the 5 songs; uses a clean bundled ~10 s clip of that song. Advances to Stage 1.

### The six stages
One large central canvas shows a single stage at a time. A 6-step progress tracker across the top highlights the current stage. Controls:

- **Spacebar** or **Next** → advance to next stage.
- **Prev** → previous stage.
- **R** → replay current stage's animation.
- Each stage animates once, then holds indefinitely so the presenter can talk over it.

| # | Stage | Visualization |
|---|-------|---------------|
| 1 | **Waveform** | The clip draws left-to-right (air pressure vs time). A **Play** button plays the clip audio so the audience hears what they see. |
| 2 | **Fourier Transform** | One short window of the waveform decomposes into constituent sine waves, then resolves into a frequency-magnitude spectrum (frequency vs amount). Supports the coin-sorting analogy. |
| 3 | **Spectrogram** | Successive FFT windows stack left-to-right into a time × frequency heatmap; brightness = amplitude. |
| 4 | **Peak detection** | Strongest local peaks light up; everything else fades, leaving the constellation map of points. |
| 5 | **Fingerprints** | An anchor peak pairs with peaks in a target zone; each pair animates into `(f₁, f₂, Δt)` → a 32-bit hash. Library/shelf analogy. |
| 6 | **Matching** | The clip's hashes look up the DB; a scatter plot of (time-in-song vs time-in-recording) forms a clean diagonal for the correct song vs scatter for the wrong ones; an offset histogram spikes; then a **"MATCH: Song — Artist"** reveal. |

## Architecture

Single HTML file with clear internal module boundaries (logically separated, one file for delivery):

- **DSP core** — pure functions, no DOM: `fft()` (radix-2), `stft()`/spectrogram, `findPeaks()` (local-maximum peak picking), `fingerprint()` (anchor→target-zone pairing → 32-bit hash), `buildDatabase()`, `match()` (hash lookup → offset voting → best song + score).
- **Audio source** — `loadCannedClip(songId)` (decode embedded MP3, slice ~10 s) and `captureFromMic(seconds)` (getUserMedia → record → PCM buffer). Both output a normalized mono Float32 PCM buffer + sample rate.
- **Renderers** — one canvas renderer per stage, each taking precomputed stage data and an animation clock.
- **Controller** — stage state machine, keyboard handling, mode selection, orchestration of precompute.
- **Data** — base64-embedded MP3s + metadata (title, artist), injected by the build step.

### Data flow (precompute-then-replay)

Heavy computation never happens mid-stage:

- **Canned:** on page load, decode songs → fingerprint each → build in-memory hash-table DB. When a canned song is chosen, precompute its clip's spectrogram/peaks/fingerprints/match result.
- **Live:** DB is built at load from the embedded songs; the captured clip's spectrogram/peaks/fingerprints/match are precomputed immediately after the ~10 s capture, before stepping begins.

Each stage renderer then just replays precomputed data against an animation clock, guaranteeing smooth, stall-free playback during the talk.

## Fingerprint / matching algorithm (Shazam-style)

- Spectrogram via STFT (windowed FFT, ~tens-of-ms windows, overlapping).
- Peak picking: keep local maxima that dominate their neighborhood in time/frequency.
- Fingerprints: for each anchor peak, pair with peaks in a forward target zone; hash `(f₁, f₂, Δt)` into a 32-bit integer.
- DB: `hash → list of {songId, timeOffset}`.
- Match: for each query hash, look up DB entries; for each hit, vote for `(songId, dbTime − queryTime)` bucket. The song with the largest single-offset vote peak wins. Score = size of that peak.

## Songs & build step

- 5 recognisable MP3s live in `./songs/` (git-ignored — local only, swappable). Metadata is parsed from the filename convention `Artist - Song title.mp3`; no separate metadata file.
- A re-runnable build script (Node) reads the MP3s, base64-encodes each **full song**, and injects them plus parsed metadata into an HTML template, producing the single-file deliverable `shazam-demo.html`. Embedding full songs means the live demo can match *any* section the presenter plays; the trade-off is a larger output file (~30–35 MB) that takes a few seconds to decode/fingerprint on first open. Songs are decoded, downmixed to mono, and resampled to a low rate (~16 kHz) in-browser for DSP — fingerprinting is robust to this.
- Swapping songs later = replace files in `./songs/`, re-run one command.
- The demo requires the 5 MP3s to exist before the first real build; the project scaffolds and is testable with placeholder audio until then.

## Testing

- **DSP core (Node):** unit tests for `fft()` against a known sine wave (energy at the expected bin), `findPeaks()` on a synthetic spectrogram, hash determinism (same input → same hash), and an end-to-end check that a clip sliced from song X matches song X in the DB with a clear score margin over the others.
- **Visual/animation layer:** verified by running the file in the browser and stepping through all stages in both modes.
- **Live-path rehearsal check:** grant mic permission and confirm a real room recording of a DB song matches, in the intended browser, before the presentation.

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Safari blocks mic on `file://` | Recommend Chrome/Edge for live; canned works everywhere. |
| Live match fails in a noisy room | Canned fallback is one click away; rehearse and tune peak/target-zone params against the actual songs. |
| Full embedded MP3s make a large (~30–35 MB) file | Acceptable for a local double-click file; decode/fingerprint once at load. If it ever becomes a problem, trim segments per song. |
| Mid-demo computation jank | Precompute-then-replay; nothing heavy runs during stepping. |

## Deliverables

1. Project scaffold: HTML template, DSP core, renderers, controller, build script, `assets/songs/` folder, Node tests.
2. Generated single-file `shazam-demo.html`.
3. Short run/rehearsal notes (how to open, grant mic, pick modes, swap songs).
