# Shazam Pipeline Demo — Design Spec

**Date:** 2026-08-30
**Purpose:** An interactive, projector-friendly visual tool for a school presentation that walks an audience through the six stages of Shazam's traditional music-recognition pipeline, ending in a live match. Runs as a companion to the slides at slide 6 ("Live Demo").

## Goals

- Visually teach the Shazam pipeline: waveform → Fourier transform → spectrogram → peak detection → fingerprints → matching.
- Be trivially easy to run under time pressure: no install, no command line, no internet.
- Cross-platform: one file that works on both Windows and Mac.
- Support a **live** demo (record a song played into the room via mic and detect it) and a **canned** fallback (deterministic bundled clip).
- The demo "does the teaching": one large animated stage at a time, driven by the presenter's narration.
- **Understandable, well-commented source** the presenter can read and follow, plus a **standalone documentation page** (a separate self-contained HTML file, offline, nicely presented) that explains the concepts, each pipeline stage, the code architecture, and how to build/run the demo. The docs page is independent of the slides.
- **Swappable songs** — the presenter can replace the MP3s and rebuild.

## Non-Goals (out of scope)

- The AI/embeddings and vector-search sections (slides 7–8) — separate topic.
- A real or large-scale song database — the local DB is a small, swappable set of full songs (sweet spot ~5–10; the build accepts any number, but many full songs make the file large and the first-load analysis slower).
- Synthetic noise injection — the live-mic path is the real-world/noise demonstration; canned stays clean. No noise toggle.
- Any server, backend, or network dependency.

## Constraints

- **Delivery:** a single self-contained `.html` file, opened by double-click (`file://`). Fully offline. (The documentation page is a second self-contained HTML file — also offline, not required to run the demo.)
- **No external libraries** — everything (including the FFT) is hand-written vanilla JS so nothing needs to load.
- **Tech:** HTML + Canvas 2D + Web Audio API + a Web Worker (created from an embedded Blob so it stays a single offline file) for background fingerprinting.
- **Readable code:** clear naming and explanatory comments throughout; each source file has one responsibility. The presenter should be able to read the code and follow it against the docs page.
- **Live mic caveat:** `getUserMedia` from a `file://` page is reliable in **Chrome/Edge** (treated as a secure context) but **often blocked by Safari on Mac**. Recommendation: present the live path in Chrome/Edge. Canned works in all browsers. Mic permission is granted once during rehearsal and the live match is verified before the day.

## User Experience

### Start screen
Dark, high-contrast, large text, minimal chrome, a **Fullscreen** button. The song fingerprint database is built in the background (Web Worker) as soon as the page opens, so it is ready by the time the presenter reaches the demo; the start screen shows a subtle "preparing…/ready" state. Two large mode buttons:

- **Live (mic):** shows a **Listen** button. On press, records ~10 s from the mic. **Stage 1's waveform is drawn in real time from the incoming mic samples as it records** (the capture *is* the Stage-1 animation), with a live input-level cue and countdown. The captured buffer becomes the recording; the remaining stages (2–6) are precomputed in the background immediately after capture, so pressing Next is instant.
- **Canned playback:** a dropdown to choose a song; uses a clean bundled ~10 s clip of that song. Advances to Stage 1. The clip's stages are precomputed before stepping.

### The six stages
One large central canvas shows a single stage at a time. A 6-step progress tracker across the top highlights the current stage. Controls:

- **Spacebar** or **Next** → advance to next stage.
- **Prev** → previous stage.
- **R** → replay current stage's animation.
- Each stage animates once, then holds indefinitely so the presenter can talk over it.

| # | Stage | Visualization |
|---|-------|---------------|
| 1 | **Waveform** | Air pressure vs time. Canned: the clip draws left-to-right. Live: drawn **in real time as the mic records**. A **Play** button plays the audio so the audience hears what they see. |
| 2 | **Fourier Transform** | Zoom into a **short slice (~tens of ms)** of the waveform and show it decomposing into its constituent **sine waves** (the strongest few frequency components animate out and sum back to the slice). Supports the coin-sorting analogy. Emphasis on decomposition into sinusoids, not a full bar-chart spectrum. |
| 3 | **Spectrogram** | Continues from Stage 2: the FFT of that same short slice becomes **one column**, then successive windows are shown **actively stacking** left-to-right into a time × frequency heatmap; brightness = amplitude. |
| 4 | **Peak detection** | Strongest local peaks light up; everything else fades, leaving the constellation map of points. |
| 5 | **Fingerprints** | An anchor peak pairs with peaks in a target zone; each pair animates into `(f₁, f₂, Δt)` → a 32-bit hash. Library/shelf analogy. |
| 6 | **Matching** | The clip's hashes look up the DB; a scatter plot of (time-in-song vs time-in-recording) forms a clean diagonal for the correct song vs scatter for the wrong ones; an offset histogram spikes; then a **"MATCH: Song — Artist"** reveal. |

## Architecture

Single HTML file with clear internal module boundaries (logically separated, one file for delivery):

- **DSP core** — pure functions, no DOM, runs in both Node (tests) and the browser/worker: `fft()` (radix-2), `stft()`/spectrogram, `findPeaks()` (local-maximum peak picking), `fingerprint()` (anchor→target-zone pairing → 32-bit hash), `buildDatabase()`, `matchQuery()` (hash lookup → offset voting → best song + score).
- **Audio source** — decode embedded MP3 → mono PCM, slice, and **streaming mic capture** (`getUserMedia` → per-chunk callback for the live Stage-1 waveform → final PCM buffer). Plus audio playback for Stage 1.
- **Fingerprint worker** — a Web Worker (built from an embedded Blob so the file stays single/offline) that runs the CPU-heavy fingerprinting off the main thread. The main thread decodes each song (Web Audio is main-thread only) and transfers PCM to the worker, which returns fingerprints; results are cached best-effort so repeat opens are fast.
- **Renderers** — one canvas renderer per stage, each taking precomputed stage data and an animation clock. Stages 2 and 3 share a `focusFrame` (the analysed slice) for visual continuity.
- **Controller** — stage state machine, keyboard handling, mode selection, and orchestration of background precompute.
- **Data** — base64-embedded MP3s + metadata (title, artist), injected by the build step.

### Data flow (precompute in background, then replay)

Heavy computation never happens mid-stage or on Next:

- **At page load (both modes):** kick off song decoding + fingerprinting in the background worker, with a progress/ready indicator. This runs while the presenter is still on earlier slides, so the DB is ready by demo time. Results cached best-effort (e.g. IndexedDB, keyed by the song set) so subsequent opens are near-instant.
- **Canned:** when a song is chosen, precompute its clip's spectrogram/peaks/fingerprints/match result before stepping.
- **Live:** the captured buffer (already visualised in real time as Stage 1) has its Stages 2–6 artifacts precomputed in the background immediately after capture, so stepping is instant.

Each stage renderer then just replays precomputed data against an animation clock, guaranteeing smooth, stall-free playback during the talk.

## Fingerprint / matching algorithm (Shazam-style)

- Spectrogram via STFT (windowed FFT, ~tens-of-ms windows, overlapping).
- Peak picking: keep local maxima that dominate their neighborhood in time/frequency.
- Fingerprints: for each anchor peak, pair with peaks in a forward target zone; hash `(f₁, f₂, Δt)` into a 32-bit integer.
- DB: `hash → list of {songId, timeOffset}`.
- Match: for each query hash, look up DB entries; for each hit, vote for `(songId, dbTime − queryTime)` bucket. The song with the largest single-offset vote peak wins. Score = size of that peak.

## Songs & build step

- Recognisable MP3s live in `./songs/` (git-ignored — local only, swappable). Metadata is parsed from the filename convention `Artist - Song title.mp3`; no separate metadata file.
- A re-runnable build script (Node) reads *all* MP3s in the folder, base64-encodes each **full song**, and injects them plus parsed metadata into an HTML template, producing the single-file deliverable `shazam-demo.html`. Embedding full songs means the live demo can match *any* section the presenter plays. Sweet spot is ~5–10 songs; the build accepts any number but prints the resulting file size and warns as it grows (many full songs → large file + slower first-load analysis). Songs are decoded, downmixed to mono, and resampled to a low rate in-browser for DSP — fingerprinting is robust to this.
- Swapping songs later = replace files in `./songs/`, re-run one command.
- The demo requires at least one MP3 before the first real build; the DSP core scaffolds and is testable (Node) with synthetic audio before any songs exist.

## Testing

- **DSP core (Node):** unit tests for `fft()` against a known sine wave (energy at the expected bin), `findPeaks()` on a synthetic spectrogram, hash determinism (same input → same hash), and an end-to-end check that a clip sliced from song X matches song X in the DB with a clear score margin over the others.
- **Visual/animation layer:** verified by running the file in the browser and stepping through all stages in both modes (Playwright for the canned path + screenshots), including Stage 2→3 continuity (shared slice) and the live real-time Stage-1 waveform.
- **Docs page:** opens offline in a browser and renders correctly.
- **Live-path rehearsal check:** grant mic permission and confirm a real room recording of a DB song matches, in the intended browser, before the presentation.

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Safari blocks mic on `file://` | Recommend Chrome/Edge for live; canned works everywhere. |
| Live match fails in a noisy room | Canned fallback is one click away; rehearse and tune peak/target-zone params against the actual songs. |
| Full embedded MP3s make a large file as song count grows | Sweet spot ~5–10 songs; build prints file size and warns; fingerprinting runs in a background worker with best-effort caching so first load is tolerable and repeat opens are fast. |
| Mid-demo computation jank | Background-worker precompute at load + precompute-then-replay; nothing heavy runs during stepping or on Next. |
| Web Worker / IndexedDB behaving differently on `file://` across browsers | Worker is created from an embedded Blob (works on `file://` in Chrome/Edge); caching is best-effort — if unavailable, fall back to recomputing at load. Recommended browser is Chrome/Edge anyway. |

## Deliverables

1. Project scaffold: HTML template, DSP core, renderers, controller, fingerprint worker, build script, `./songs/` folder, Node tests — all readable and commented.
2. Generated single-file `shazam-demo.html`.
3. A standalone, self-contained documentation page (`docs/how-it-works.html`) explaining the concepts, each pipeline stage, the code architecture, and the build/run steps — opens offline in a browser.
4. Short run/rehearsal notes (also surfaced in the docs page): how to open, grant mic, pick modes, swap songs.
