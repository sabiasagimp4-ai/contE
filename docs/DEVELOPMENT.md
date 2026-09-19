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

## Cycle 5: timeline engine and an editable camera track (P2)

- Problem: the timeline was a slab of DOM code inside `src/app.js` with no ruler, no snapping, no playhead following and a fixed 1–12 px/frame slider that could neither show a 500-panel project whole nor work at frame precision. Camera motion was limited to a start key plus one end key set from the inspector, so a pan that should settle mid-panel could not be expressed at all.
- Change: `src/timeline.js` is a DOM-free engine — scale ladder, viewport culling, fps-based tick spacing and labels, snap targets and snapping, zoom anchoring, playhead following, selection range and fit. `src/app.js` now only renders what the engine returns. The model gained `setCameraKey`, `moveCameraKey`, `removeCameraKey` and `describeCamera`, so camera keys can sit at any time inside a panel and every surface (playback, inspector, paper) reads the same interpolation and the same wording.
- Duration rule, stated: camera keys keep a ratio `t` within the panel, so changing a panel's duration stretches its camera move by the same ratio. The inspector and the track show each key in frames, so the ratio never has to be reasoned about directly; the rule is written in the README and in the camera tab.
- Timeline UI: fps ruler whose step is chosen so labels cannot collide, a band and a readout for the selected range, snapping to panel boundaries, seconds and the playhead (Alt suspends it), wheel zoom anchored at the cursor, slider zoom anchored at the playhead, fit (F), and playhead following that scrolls only when the head reaches the edge. The camera track shows one lane per panel: drag a key to move it, double-click a lane to add one, Delete removes the selected key.
- Paper: notation now comes from the same key list — solid start frame, dashed end frame, a polyline through every key with an arrowhead, dots on intermediate keys, and a text line naming the move (PAN / TILT / ZOOM / ROLL) with each key's frame, or HOLD.
- Validation: 42 unit tests (12 new) cover the engine (conversion, culling, tick steps, snapping, zoom anchoring, following, range, fit) and camera keys (add without changing the picture, move, merge on collision, refusing to delete the last key, stretching with duration, description wording, keys surviving a shot split and undo). The browser run adds ruler labels, the range readout, adding a key at the playhead, editing it, dragging it, deleting it, undoing back, clip culling with 500 panels (fewer than 40 clips), fit, exact boundary scrubbing (47f reads 1s23f, 48f reads 2s00f, and snapping pulls 47f to the boundary) and playhead-following scroll. No page errors.
- Measurements (20 samples, 500 panels): engine calls are the cheap part — visible 0.01ms, ticks 0.01ms, snap 0.00ms median; the browser samples showed scroll 17.7 / 33.4ms and zoom 33.3 / 33.3ms end to end in two runs, including two animation frames of waiting. Save and load are unchanged from cycle 4 within noise.
- Two behaviours corrected during the browser pass: K placed its key in the selected panel even when the playhead was elsewhere (it now targets the panel under the playhead and selects it), and the boundary test showed snapping was doing its job, so the test now checks both the snapped and the Alt-suspended result.
- Remaining: clips cannot be dragged along the timeline, there is no easing, camera cannot be manipulated directly on the canvas, and there are still no audio or dialogue tracks.
- Next highest value: P3 — an Audio Engine with cached waveforms, clips for dialogue/SE/BGM on the timeline, and playback synchronised to the audio clock.

## Cycle 6: audio clips, cached waveforms and a synchronised clock (P3)

- Problem: sound existed only as a text note in the inspector. Nothing could be placed in time, nothing could be heard, and the paper output repeated whatever the user had typed rather than describing what was actually placed.
- Change: schema v4 adds `project.audio` clips — asset reference, track (dialogue/SE/BGM), anchor panel, offset within the panel, length, source offset and gain — with a v3→v4 migration. `src/audio.js` is a new Audio Engine: clip resolution to absolute frames, scheduling maths, waveform peaks, sound notes for paper, and a decode/waveform cache around Web Audio. The timeline grew three audio lanes with waveforms, drag to move and an edge to trim; the inspector grew a sound tab with import, gain, length, source offset, delete and repair.
- Position rule, stated: a clip belongs to the panel its start sits on and is stored relative to that panel. Change an earlier duration and the sound moves with its picture; delete the panel and the clip goes with it, returning together on undo. The rule is written in the README, in the sound tab and in the handover document.
- Synchronisation: playback derives the frame from `AudioContext.currentTime` whenever clips are scheduled, and falls back to the display clock when the project is silent. Every play call stops the previous sources first, so repeated seeks and a hammered play button cannot stack two playbacks. Stopping silences everything.
- Paper: sound notes now come from actual overlap — the typed note plus each clip that covers the panel, marked "（続き）" when it started earlier and "+12f" when it starts late.
- Validation: 51 unit tests (9 new) cover clip resolution, the anchoring rule under duration changes, re-anchoring on move, orphan pruning, scheduling (including mid-playback offsets and the project end), sound notes, waveform peaks and an engine driven by a fake audio context. The browser run imports a generated 3-second WAV, checks the waveform, drags the clip, deletes the host panel and undoes it, then measures playback against wall time.
- Measurement: 4 seconds of playback advanced 94 frames, a drift of −2 frames (≈83ms, which includes the deliberate 60ms scheduling lead and the resolution of the frame readout). The number is printed as `sync` by `npm run test:browser` so it can be compared between runs.
- Two defects found and fixed while wiring this up: the audio lanes were taller than the default timeline pane so clips sat below the fold (the default height is now 270px and lane labels no longer swallow pointer events), and — older and more serious — `Store.edit` treated any truthy return value from an edit command as a selection. Since the assignment in the drawing command returns the strokes array, drawing on any panel but the first silently jumped the selection to panel 1. Selections are now only taken from objects that actually carry `active` or `ids`, with a test for values returned by assignment.
- Remaining: no fades or volume curves, no mix of multiple channels for export, no audio in any exported file, and the waveform is drawn per clip on the UI thread.
- Next highest value: P4 — paper settings in the project, long-text continuation instead of truncation, and a cancellable export with progress.

## Cycle 7: paper as a production output (P4)

- Problem: the paper output was A4 portrait only, its columns were a fixed image-plus-text pair, long text was cut with an ellipsis (and the export was blocked when that happened), the preview rendered every page synchronously to detect overflow, and PNG export fired one download per page.
- Change: schema v5 stores `project.paper` — size (A4/A3/B4/Letter), orientation, rows, margin, font, header, footer, ordered columns with individual widths and visibility, and switches for duration, hierarchy numbers and camera marks — with a v4→v5 migration. `src/paper.js` became a renderer over a computed geometry (page box, row height, column boxes) plus `layoutPages`, which wraps each column's text and moves whatever does not fit onto the next row or page. `src/exporter.js` is new: page-by-page iteration that yields to the browser between pages, progress callbacks, a cancellable job, and a dependency-free store-only ZIP writer.
- No text is lost: a panel whose text overruns its row continues on the next row, marked "（続き）" under its CUT number, and the unit test asserts that all 600 characters of a long line survive the split. The export is no longer blocked; there is nothing to block on.
- The preview now renders only the page being viewed. PNG export produces one ZIP named after the project instead of N browser downloads, and both print and PNG show "n / total" with a 中止 button.
- Validation: 58 unit tests (7 new) cover geometry for each size and orientation, column order and width distribution, wrapping (including explicit newlines), continuation without loss, pagination at 1/4/8 rows, column text for numbers, duration, sound and camera, export progress and cancellation, and the ZIP container. The ZIP was also opened with Python's `zipfile` (including a UTF-8 filename) to check it against a real reader, not just against my own byte offsets.
- Browser checks: A4 → A3 → landscape → A4 switches the canvas between 1240×1754, 1754×2480 and 2480×1754; long Japanese text with ……！？＜＞＆「」〜①㈱♪ continues instead of truncating; the ZIP downloads under the project name; with 500 panels (125 pages) the first preview came back in 82ms and a PNG export was cancelled at page 17 with the dialog still responsive. Printing a 7-panel project through headless Chromium produced a 2-page PDF with zero margins.
- Measurement: `layoutPages` for 500 panels runs at a median of 2.51ms (p95 6.97ms) with a synthetic text measurer; in the browser the first preview including real text measurement and one page render took 82ms.
- Remaining: the PDF is still an image of each page (no selectable text), row heights are uniform, there is no template to reuse settings across projects, and generation still happens on the UI thread between frames. Windows printing and PDF saving remain untested — there is no Windows machine in this environment.
- Next highest value: P5 — animatic export driven by the same frame evaluation as playback, then the desktop shell comparison.

## Cycle 8: animatic export, and the desktop question left open (P5)

- Problem: everything the editor knew about timing, camera and sound could be seen on screen or printed, but not handed to anyone as a movie. The roadmap's last phase also asked for a Windows desktop build — which cannot be decided, let alone measured, from this Linux container.
- Change: `src/animatic.js` plans an export (output fps, resolution, frame-to-time mapping), evaluates each frame through the *same* `rowAtFrame` + `cameraAt` + `draw` path as playback, and wraps `MediaRecorder`. Two formats: WebM (VP9/VP8 + Opus, sound included, recorded in real time) and a frame-exact PNG sequence zipped for an external encoder. The audio engine gained a stream destination, so a recording schedules exactly the same clips as playback, just routed to the recorder.
- Cancellation and safety: both formats use the exporter's `Job`. A cancelled recording discards the chunks it had rather than handing over a truncated file, export never writes to the project, and an unsupported codec is reported in the dialog with the button disabled instead of failing at click time.
- Validation: 63 unit tests (5 new) cover the frame plan across fps changes, frame evaluation at panel boundaries and mid-move (compared against `cameraAt` directly), filename sanitising, recording progress, and codec fallback. The browser run exports a PNG sequence, then records a WebM and *plays it back inside the browser* to measure it: duration, decoded audio (length and peak), frame size, and dark-pixel counts at two times to prove the picture changes with the timeline.
- Measured on this environment (headless Chromium 1194). Short project, in the smoke run: 6.46s of project recorded 6.54s of video (+0.08s, two frames at 24fps) at 854×480 with audio present (peak 0.37); the audio track measured 4.44s because the project's sound stops before the end — trailing silence is not encoded, which does not move the sound.
- The roadmap's actual acceptance case was run end to end: a three-minute project (90 panels, 4320 frames, 854×480, 24fps) with a ten-second sound at the one-minute mark. It took 180.2s of wall clock (real-time recording), produced 180.09s of video in 1.09MB, and the sound landed at 60.13s–70.08s against 60s–70s in the project — the 0.12s offset is the deliberate scheduling lead, which holds frame 0 at the head rather than desynchronising picture from sound. Panels were identified by giving each a different number of strokes: sampling the recording at panels 0, 1, 2, 3, 4, 45 (the one with a camera move) and 89 returned exactly the expected pictures. Real-time recording means a three-minute animatic costs three minutes; the frame-exact PNG path exists for when that is unacceptable.
- Not done, and not claimable: the Windows desktop build. There is no Windows machine here, so pen input, file overwrite, audio latency and memory cannot be measured, and picking a shell without those numbers would be guessing. `docs/DESKTOP.md` records what to measure, the candidate shells with their trade-offs, and the codec/licence position (VP9 + Opus by default because they are royalty-free; H.264 only through an external encoder, with the patent pool called out).
- Remaining: offline (faster than real time) export via WebCodecs or an external encoder, H.264/ProRes options, audio fades and mixing, and the whole desktop shell with direct file saving and bundled assets.
- Next highest value: measure the six Windows items in `docs/DESKTOP.md` on real hardware, then move persistence to native files before touching the exporter again.

## Cycle 9: post-merge data safety and selection invariants

- Problem: review of PR #2 found three reproducible regressions. Asset garbage collection considered only the current project, so a binary could disappear while a retained snapshot or Undo state still referenced it. Clearing a Panel image filtered `project.assets` using image IDs and therefore removed every audio asset. Ctrl/Cmd-clicking the active Panel out of a multi-selection could leave the Inspector's `active` Panel outside the bulk-edit `ids`.
- Cause: binary reachability stopped at the current project; image cleanup did not distinguish asset kinds; selection normalisation validated existence but did not enforce `active ∈ ids`.
- Change: `ProjectRepository.pruneAssets` now computes reachability across the current project, every readable retained snapshot and supplied Undo/Redo projects. Image removal moved into `clearPanelImage`, which removes only unreferenced image metadata and preserves audio. Selection normalisation moves `active` to a remaining selected Panel when the previous active Panel is toggled out, and the playhead follows the normalised active Panel.
- Validation: three regression tests were added (66 unit tests total). They cover retained-snapshot and Undo asset reachability, image removal in a project with a valid audio clip, and the active/selected invariant. `npm test`, `npm run build`, `git diff --check` and the complete browser smoke test pass. Browser results: 501-Panel UI 14.0ms, Scene navigation 26.0ms, Timeline scroll 29.5ms, zoom 32.8ms, playback start 36.1ms, autosave 1318.3ms, no page errors.
- Improvement: recovery generations and Undo/Redo no longer lose their image/audio binaries during garbage collection; image clearing works in sound-bearing projects; Inspector, bulk edit target and playhead stay aligned after multi-selection changes.
- Remaining: corrupt retained snapshots cannot contribute reachability because their payload cannot be parsed; the current policy keeps them for diagnosis but continues collection using readable generations. Asset reachability is recalculated at save time and has not yet been profiled with many thousands of assets.
- Next highest value: snapshot paper-export inputs at job start so changing paper settings cannot mutate a multi-page export in progress, then bound or stream PNG-sequence animatic memory use.

## Cycle 10: adversarial stability checks and latency reduction

- Problem: ordinary feature tests did not exercise long random edit sequences, extremely long timelines, repeated asset kinds, incremental ZIP output, or paper export while settings changed. The timeline also materialised one snap target for every second without a bound, and PNG animatic export retained a frame metadata array until the final ZIP was created. Autosave intentionally waited 1.2 seconds after a change.
- Change: added a deterministic 24-seed randomized model test covering add, duration, Camera, text, Scene/Shot, split/merge, move, selection, undo/redo, paper settings, audio resolution, schedule clipping, layout and JSON round trips. Snap targets now cap second marks at 4096 while retaining every Panel boundary. Snapshot metadata stores `assetIds`, so asset GC avoids reparsing every retained payload. `resolveClips` uses an asset map, paper export snapshots its Project/settings/pages and disables settings while running, and `ZipBuilder` lets Animatic PNG frames enter the ZIP incrementally. PNG export yields every four frames instead of waiting one animation frame per frame while still checking cancellation before every frame.
- Autosave latency: the default debounce is now 600ms and the continuous-edit ceiling is 4s. This reduces the deliberate wait before a browser save while keeping writes coalesced during active editing.
- Validation: unit tests increased to 73 and all pass; build and diff checks pass; the full Chromium smoke test passes with no page errors. Long-timeline candidate generation for 864,000,000 frames stays under 4,100 targets and completes in the millisecond range. With 5,000 assets and eight retained snapshots, metadata-based asset reachability measured about 10ms versus about 40ms when reparsing all eight payloads in the same Node process. Browser smoke remains responsive at 501 Panels: duration 11.3ms, Scene navigation 30.4ms, Timeline scroll 33.1ms, zoom 33.2ms, playback start 35.7ms, and autosave 772.9ms.
- Remaining: browser rendering still runs on the UI thread; PNG ZIP output still retains encoded bytes until download because the browser Blob must be finalised, and large paper/Animatic jobs need an OPFS/File System Access streaming path to remove that upper memory bound. Windows pen latency and native file I/O remain unmeasured.
- Next highest value: add a worker-backed render/export path and a browser stress test that edits paper settings during a multi-page export, then measure 1,000–5,000 Panel projects with real image/audio assets.

## Cycle 11: a panel workspace instead of one fixed screen

Feature work between cycle 10 and this entry (the A/B/C/D/E series: timeline handling,
search, work area, markers, label colours, camera easing, vertical paper, asset-bundled
`.conte.zip`, split serialisation, multi-tab exclusion) is tracked item by item in
`docs/FEATURE_IMPLEMENTATION_PLAN.md` rather than here.

- Problem: the screen showed everything all the time. Roughly forty controls sat in the
  top bars, the tree / inspector / timeline could be resized but never closed, and a
  one-line shortcut list was glued under the stage with `white-space: nowrap`, so most of
  it was clipped and unreadable while still taking vertical space away from drawing.
  Paper and animatic output were modal dialogs, so a page could not be watched while the
  dialogue that fills it was edited — and the preview only rebuilt when paper settings
  changed, never when the project did.
- Change: the screen is now docks and panels (`src/ui/docks.js`), which hold only the
  state of which panel is open and which is in front; the DOM contract is four data
  attributes. Panels close from a tab's × or the window menu, an empty dock disappears
  along with its splitter, and `~` maximises the panel under the cursor. Keys and their
  on-screen descriptions come from one table (`src/ui/shortcuts.js`), so the help panel
  cannot drift from what actually fires. File operations fold into a File menu
  (`src/ui/menu.js`), presentation mode rides on top of maximise instead of repeating it,
  three workspaces (draw / time / finish) switch panels and sizes together, and paper and
  animatic became tabs in the centre dock. The paper page follows edits while its panel is
  open and is never laid out while it is closed. Printing goes through a `#printArea`
  under `body` with `@page` generated from the paper size, which removes the manual
  "match the paper size in the print dialog" step.
- Effect: closing the tree and the thumbnail strip roughly doubles the drawing area
  without leaving the editor. The shortcut list is complete (it previously omitted Ctrl+F,
  Ctrl+K and the zoom keys) and lives in a panel instead of a clipped line.
- Defects found and fixed by the rework: Ctrl+F also triggered F (fit timeline) because a
  second handler matched on the key alone; `.panel` styled both dock frames and tree rows,
  so frame rules leaked into the tree; a saved layout was applied without validation, so a
  corrupt record could leave the app unopenable; status messages were clipped at 36
  characters with no way to read the rest; and `@media (max-width: 900px)` still carried
  grid rules plus a `display: none` that fought the dock state.
- Behaviour deliberately kept: an animatic recording still locks the rest of the UI,
  because recording runs in real time — but it locks *human input only*. Asynchronous
  imports started before the recording still commit, which is what E3 (output content
  frozen at start) already guarantees is safe.
- Validation: unit tests grew from 253 to 277, with new suites for the shortcut table,
  the dock state machine and the panel/workspace data (including "every closable panel is
  reachable from the window menu"). The browser smoke test gained the panel UI, the file
  menu, workspaces, presentation-on-maximise, the narrow viewport, paper following edits,
  paper *not* rebuilding while closed, the generated `@page` rule and the recording lock.
  `npm test`, `npm run build` and the full Chromium smoke pass with no page errors.
  501-panel smoke on this environment: duration 27.6ms, Scene navigation 26.1ms, Timeline
  scroll 33.3ms, zoom 33.4ms, playback start 36.5ms, longest task during E1 editing 74ms
  (156ms and 159ms in two runs before and after the paper panel — unchanged within noise).
  Autosave for 501 panels ranged 128–775ms across runs on both the old and new code and is
  not a usable comparison.
- Remaining: panels cannot be dragged between docks and there is no second window; the
  same panel list still appears in three places (tree, thumbnails, timeline row) by
  default, which is now a user choice rather than a constraint; printing was exercised
  through headless Chromium only, so the generated `@page` size has not been checked
  against a physical printer.

## UX evaluation

Counts describe editor commands (a shortcut chord counts as one); typing values and operating OS dialogs are separate.

| Task | Current count / measurement |
|---|---|
| Panel add / duplicate / previous-next | 1 shortcut |
| Panel reorder | 1 drag in the strip (multi-selection moves together) |
| Range select | 1 Shift-click |
| Brush / eraser switch | 1 shortcut (E) |
| Image import | 1 click plus the OS file dialog (inspector, 内容 tab) |
| Scene / Shot rename | 1 double click, or the structure tab |
| Frame duration ±1 | 1 shortcut; multiple selected panels share edit |
| Exact duration | Focus, value, commit |
| Shot split / merge | 1 shortcut (valid boundary) |
| Scene navigation | Open Scene, select Shot: 2 clicks |
| Camera key at the playhead | 1 shortcut (K); 1 double click on the lane; drag to move |
| Place a sound | 1 click plus the OS file dialog; drag to move, edge to trim |
| Timeline fit / zoom | 1 shortcut (F) / 1 shortcut or wheel |
| Paper output | 1 click opens the paper tab, 1 more starts print / PNG; OS save extra; the page follows edits while the tab is open; settings persist with the project |
| Animatic export | 1 click opens the animatic tab, 1 more starts the export; WebM runs in real time, PNG sequence is frame-exact |
| Save / open a file | 2 clicks (File menu, the entry) plus the OS file dialog |
| Show or hide a panel | 1 click on a tab's ×, or 2 through the window menu; 1 shortcut (~) to maximise |
| Switch workspace | 2 clicks (window menu, the workspace) |
| Paper settings | changed in place, undoable, saved with the project |
| Recovery | 1 undo chord restoring selection; last Panel deletion blocked; crash recovery offered on startup (1 click) |
| 100–500 Panel model | benchmark in `scripts/bench.mjs`, synthetic strokes |
| 500 Panel UI duration | 12.6 / 23.5ms in two headless smoke samples |
| 500 Panel Scene selection | 27.4 / 36.3ms |
| Timeline scroll / zoom | 33.3 / 33.3ms and 30.8 / 33.2ms |
| Playback initiation | 33.5 / 33.4ms |
| Save | automatic, 1.2s after the last edit; 500 Panel in-memory save median 72.45ms, load 116.72ms; IndexedDB and OS disk completion not separately measured |

Counts above were re-checked against the panel UI in cycle 11; rows not listed in that
entry date from earlier cycles and were not re-measured.

Browser timings include waiting for two animation frames after dispatch, so are coarse response checks, not pure engine timings, distributions, GPU profiling or Windows pen measurements. Fixture: five Scenes × 100 Panels, 500 points per Panel. UI sample is not a performance guarantee. Browser QA tools are external to the app; no runtime libraries were added.

## Reference adaptation

Official product page: https://www.toonboom.com/products/storyboard-pro
Official knowledge base: https://helpcentre.toonboom.com/hc/en-ca/categories/39971055086995
Both consulted 2026-09-13. The knowledge base separates drawing, narrative hierarchy, animatic timing/camera, sound and exports. contE adopts shared narrative timing and reversible edits; audio and native exporters remain explicit roadmap phases. No vendor code, art, UI assets or private specifications were copied.

Final paper QA: Japanese font loaded in the test environment, visually inspected output; Chromium print rendering produced exactly one PDF page for a two-panel/four-rows fixture. Physical printer behavior and Windows drivers remain untested. PNG download was verified by the browser download event. Final shortcuts also include K for endpoint Camera commit and +/- for Timeline Zoom.

Cycle 3 note: the numbers above were re-measured on 2026-09-13 with Playwright 1.56 and the environment's Chromium 1194; earlier cycles reported a different sample. Playwright and Chromium are external QA tools and are not part of the application or its dependencies.

Cycle 4 note: the save/load numbers in the UX table above predate schema v3; the current figures are in the cycle 4 entry. Browser samples continue to include two animation frames of waiting and remain single samples, not distributions.

Cycle 5 note: timings above were taken on Node 22.22 with the environment's Chromium 1194 and remain single browser samples. Engine timings are pure function calls and exclude layout and paint.

Cycle 6 note: the synchronisation figure is one four-second headless sample on a machine with no audio hardware; it measures the app's own clock against wall time, not acoustic output.

Cycle 7 note: paper figures come from one headless run each; the PDF check used Chromium's own print pipeline, which is not the same as a Windows printer driver.
