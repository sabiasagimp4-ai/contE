# Development cycles — 2026-09-13

## Cycle 1: coherent first editing slice

- Problem: repository had only README; there was no prior model or executable to improve.
- Change: frame-based Scene/Shot/Panel schema, validator, atomic history, Canvas strokes, inspector, timeline handles, camera interpolation and monotonic playback, save/load.
- Reason/effect: one model drives timing and exports; new Panel and duration nudges each require one shortcut. Split/merge preserve global order and timing. Text focus blocks global shortcuts.
- Validation: model roundtrip, invalid edits, history, split/merge, camera endpoints and frame boundaries covered by automated tests.
- Remaining: no assets/audio engine, native packaging, migration from older releases, pressure/eraser, arbitrary camera keys.
- Next highest value: shared paper renderer, then measure large projects.

## Cycle 2: paper output and measured history optimization

- Problem: full deep copy made 500-panel duration edits expensive; all-page Canvas preview would retain large pixel buffers.
- Change: validated immutable stroke sharing across history; viewport-only Timeline clips; visible thumbnail drawing; one-page preview and sequential PNG rendering. Paper supports field switches, row count, margins, font, image width, headers, camera arrows/frames/HOLD. Detect overflow before permitting export. Aspect ratio preserved when rows get shorter.
- Effect: on this Node 24 Linux environment, 500 panels with 10 strokes × 50 points each, duration edit + undo median changed 114.92 → 0.12ms, p95 147.28 → 0.41ms (20 samples; JIT affects small values). This is model time, not end-to-end UI latency. 100 panels: 24.79 → 0.30ms. Timeline index 500 panels median 0.02ms.
- Tradeoff: validation freezes loaded strokes. JSON serialization median 66.32ms and parse/validation 64.06ms for ~2.97MB after optimization, versus 35.56/33.19ms before. Next persistence design should separate assets and serialize off the UI thread; do not claim all operations became faster.
- Validation: Canvas adapter produced paper pages; long text triggers overflow. Eight unit tests pass, including mutation protection and history recovery. Browser smoke checks drawing, N, frame nudge, undo/redo, text focus, drag resize, save, PNG download, paper preview and loading 500 panels. No page errors.
- Remaining: paper preview checks every page synchronously; printing still materializes all pages as images. Very large paper jobs need a worker/cancellable export. A4 only, image-based PDF, host fonts required for Japanese text, no independent text-column widths.
- Next highest value: crash recovery and file-backed asset storage; then audio placement and export clock synchronization.

## UX evaluation

Counts describe editor commands (a shortcut chord counts as one); typing values and operating OS dialogs are separate.

| Task | Current count / measurement |
|---|---|
| Panel add / duplicate / previous-next | 1 shortcut |
| Frame duration ±1 | 1 shortcut; multiple selected panels share edit |
| Exact duration | Focus, value, commit |
| Shot split / merge | 1 shortcut (valid boundary) |
| Scene navigation | Open Scene, select Shot: 2 clicks |
| Camera end key | Inspector values, then 1 commit button |
| Paper output | 2 clicks to print dialog / PNG initiation; OS save extra |
| Recovery | 1 undo chord; last Panel deletion blocked; no crash recovery yet |
| 100–500 Panel model | benchmark in `scripts/bench.mjs`, synthetic strokes |
| 500 Panel UI duration | 13.8ms in one headless smoke sample |
| 500 Panel Scene selection | 31.3ms |
| Timeline scroll / zoom | 33.6 / 33.4ms |
| Playback initiation | 33.3ms |
| Save | serialization median 66.32ms; OS disk completion not measured |

Browser timings include waiting for two animation frames after dispatch, so are coarse response checks, not pure engine timings, distributions, GPU profiling or Windows pen measurements. Fixture: five Scenes × 100 Panels, 500 points per Panel. UI sample is not a performance guarantee. Browser QA tools are external to the app; no runtime libraries were added.

## Reference adaptation

Official product page: https://www.toonboom.com/products/storyboard-pro
Official knowledge base: https://helpcentre.toonboom.com/hc/en-ca/categories/39971055086995
Both consulted 2026-09-13. The knowledge base separates drawing, narrative hierarchy, animatic timing/camera, sound and exports. contE adopts shared narrative timing and reversible edits; audio and native exporters remain explicit roadmap phases. No vendor code, art, UI assets or private specifications were copied.

Final paper QA: Japanese font loaded in the test environment, visually inspected output; Chromium print rendering produced exactly one PDF page for a two-panel/four-rows fixture. Physical printer behavior and Windows drivers remain untested. PNG download was verified by the browser download event. Final shortcuts also include K for endpoint Camera commit and +/- for Timeline Zoom.
