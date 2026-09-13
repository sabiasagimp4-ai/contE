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

## Cycle 3: persistence, recovery and history that does not lie

- Problem: work existed only in memory. A closed tab, a crash or a forgotten download lost everything; the sole "save" was a file download. History also consumed steps for commands that changed nothing (split at a shot head, `[` at one frame) and forgot which panels were selected, so undo left the user somewhere else.
- Change: `src/repository.js` (`ProjectRepository`, `Autosaver`) and `src/storage.js` (`IndexedDbStorage`, `MemoryStorage`) own persistence; `src/app.js` only reports state. Schema moved to v2 with an `assets` list and `panel.image` reference, plus a v1→v2 migration that does not touch the source object. `Store.edit` returns whether anything changed, keeps selection in each history entry and skips no-op commands.
- Effect: edits autosave 1.2s after the last change (8s ceiling), the header shows 未保存 / 保存中 / 保存時刻 / 失敗, and startup offers the previous session with its date, title, panel count and kind. Undo/redo restore the selection and playhead. Asset binaries live in a separate object store, so history and project JSON never carry pixel or audio data.
- Data protection rules implemented: validate before any write; each save is a new snapshot (8 kept, newest manual always kept) so a corrupt write cannot overwrite the last good one; unreadable snapshots are skipped, not deleted; a quota error prunes old saves and retries exactly once, then reports failure and keeps the change pending; a failed save never renders as success and never auto-retries in a loop.
- Validation: 26 unit tests (11 new) cover migration, asset references, no-op history, selection restore, snapshot pruning, corrupt payloads, quota exhaustion, dismissal, orphan asset pruning and autosave states. Browser smoke now edits a 500-panel project, waits for the persisted state, reloads the page, accepts the recovery dialog and checks that 501 panels and the title come back; no page errors.
- Measurements on this Node 22.22 Linux environment (20 samples, synthetic 10 strokes × 50 points per panel): 500 panels save median 72.45ms / p95 96.75ms, load median 116.72ms / p95 154.70ms, 2.98MB; 100 panels 8.80 / 15.46ms, 595KB. These use the in-memory storage adapter and exclude IndexedDB and disk time. In Chromium the full autosave of 501 panels completed 1368.8ms and 1312.6ms after the keystroke in two headless samples, of which 1200ms is the deliberate debounce.
- Two defects found by the browser run and fixed before commit: the `payloads` object store was missing from the IndexedDB schema so every save failed, and edits made before the database finished opening were never scheduled. Both are now covered by the smoke run's reload check.
- Remaining: saves still serialize on the UI thread (a worker is needed before very large projects), no direct file overwrite, no asset-bundled export, no UI yet creates assets — `panel.image` is the seam P1 will use, and images are not drawn yet.
- Next highest value: P1 image import and drawing tools on top of the asset store, then panel range selection and drag reordering.

## Cycle 4: drawing tools, image assets and panel handling (P1)

- Problem: one fixed-width pen, no eraser, no pressure, no way to zoom into a drawing, no way to bring in a photo or scan, no range selection or drag reordering, unnamed shots, and fixed pane widths. A rough pass of ten panels meant fighting the tools rather than the story.
- Change: schema v3 gives each stroke `{size, erase, points:[x,y,pressure]}` and each shot a `name`; a v2→v3 migration lifts old drawings unchanged (constant width, pressure 1). `src/drawing.js` now owns brush width, eraser, pressure, image compositing and the editor's zoom/pan transform. `movePanels` in the model moves a selection before or after any panel, across shots and scenes, dropping shots and scenes that become empty. The strip drags to reorder, Shift-click selects a range in global order, the tree renames scenes and shots on double click, and the four panes resize with the sizes stored in the repository's meta store.
- Images: the imported file is stored as the asset binary; the project keeps only `{assetId, opacity}` plus metadata (name, MIME, bytes, original pixel size). Display bitmaps are downscaled to a 2048px long edge, so a 6000px scan does not cost 6000px of texture on every repaint while the original is kept for future export. Missing binaries are reported in the inspector and in a status message rather than silently drawing nothing — `.contp` files do not carry assets.
- Eraser correctness: erase strokes composite on a separate surface and the destination is filled white first, so erasing never punches transparent holes into the paper page, the PNG export or the previous frame. The browser check asserts both that the stroke disappears and that no pixel ends up with alpha < 255.
- Validation: 30 unit tests (4 new: stroke attribute validation, cross-scene moves, no-op moves, v2 fixture migration) and a browser run that draws, erases, range-selects, drag-reorders, undoes, renames a scene, drags a pane, imports a real PNG (verified by sampling the canvas pixel), then reloads and recovers the project with the image and pane width intact. No page errors.
- Measurements after the schema change (20 samples, 500 panels, 10 strokes × 50 points each, now with pressure): save median 84.56ms, load 193.96ms, 3.69MB, versus 72.45 / 116.72ms and 2.98MB for v2 data. The third coordinate per point costs roughly 24% more bytes; validation walks each point, which is where the load time went. In Chromium, the 501-panel autosave completed 1343.8ms after the keystroke (1200ms of that is the debounce).
- One defect found by the browser check and fixed before commit: the eraser composited its surface over the previous frame, so erased areas showed the old drawing instead of paper.
- Remaining: no layers, shapes, text or colour; no copy/paste of panels; the timeline still only reorders by duration handles; drawing still repaints the whole canvas per pointer move.
- Next highest value: P2 — separate a Timeline Engine out of `src/app.js`, add fps rulers, playhead-following scroll and arbitrary camera keys.

## UX evaluation

Counts describe editor commands (a shortcut chord counts as one); typing values and operating OS dialogs are separate.

| Task | Current count / measurement |
|---|---|
| Panel add / duplicate / previous-next | 1 shortcut |
| Panel reorder | 1 drag in the strip (multi-selection moves together) |
| Range select | 1 Shift-click |
| Brush / eraser switch | 1 shortcut (E) |
| Image import | 1 click plus the OS file dialog |
| Scene / Shot rename | 1 double click, or the structure tab |
| Frame duration ±1 | 1 shortcut; multiple selected panels share edit |
| Exact duration | Focus, value, commit |
| Shot split / merge | 1 shortcut (valid boundary) |
| Scene navigation | Open Scene, select Shot: 2 clicks |
| Camera end key | Inspector values, then 1 commit button |
| Paper output | 2 clicks to print dialog / PNG initiation; OS save extra |
| Recovery | 1 undo chord restoring selection; last Panel deletion blocked; crash recovery offered on startup (1 click) |
| 100–500 Panel model | benchmark in `scripts/bench.mjs`, synthetic strokes |
| 500 Panel UI duration | 12.6 / 23.5ms in two headless smoke samples |
| 500 Panel Scene selection | 27.4 / 36.3ms |
| Timeline scroll / zoom | 33.3 / 33.3ms and 30.8 / 33.2ms |
| Playback initiation | 33.5 / 33.4ms |
| Save | automatic, 1.2s after the last edit; 500 Panel in-memory save median 72.45ms, load 116.72ms; IndexedDB and OS disk completion not separately measured |

Browser timings include waiting for two animation frames after dispatch, so are coarse response checks, not pure engine timings, distributions, GPU profiling or Windows pen measurements. Fixture: five Scenes × 100 Panels, 500 points per Panel. UI sample is not a performance guarantee. Browser QA tools are external to the app; no runtime libraries were added.

## Reference adaptation

Official product page: https://www.toonboom.com/products/storyboard-pro
Official knowledge base: https://helpcentre.toonboom.com/hc/en-ca/categories/39971055086995
Both consulted 2026-09-13. The knowledge base separates drawing, narrative hierarchy, animatic timing/camera, sound and exports. contE adopts shared narrative timing and reversible edits; audio and native exporters remain explicit roadmap phases. No vendor code, art, UI assets or private specifications were copied.

Final paper QA: Japanese font loaded in the test environment, visually inspected output; Chromium print rendering produced exactly one PDF page for a two-panel/four-rows fixture. Physical printer behavior and Windows drivers remain untested. PNG download was verified by the browser download event. Final shortcuts also include K for endpoint Camera commit and +/- for Timeline Zoom.

Cycle 3 note: the numbers above were re-measured on 2026-09-13 with Playwright 1.56 and the environment's Chromium 1194; earlier cycles reported a different sample. Playwright and Chromium are external QA tools and are not part of the application or its dependencies.

Cycle 4 note: the save/load numbers in the UX table above predate schema v3; the current figures are in the cycle 4 entry. Browser samples continue to include two animation frames of waiting and remain single samples, not distributions.
