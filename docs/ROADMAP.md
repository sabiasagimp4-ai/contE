# contE roadmap

2026-09-13: audited all repository files and branches: main contained README only. No application, dependencies, migrations or tests existed.

1. First usable foundation (this iteration): browser-hosted local editor, Scene/Shot/Panel model, frame timing, strokes, selection, split/merge, history, save/load, camera interpolation, timeline and playback.
2. Paper production (this iteration): shared project-derived pagination, configurable columns/rows/margins/type/header, camera notation, print/PDF via print dialog, numbered PNG pages.
3. Production reliability: crash recovery and autosave in IndexedDB with a separated asset store and schema migration, image import, brush/eraser/pressure drawing, panel range selection and drag reordering, resizable panes (2026-09-13), then a separated timeline engine with fps rulers, snapping, playhead following and an editable camera track (2026-09-14); then audio clips with cached waveforms and playback synchronised to the audio clock (2026-09-14); then paper production output with page setup, ordered columns, long-text continuation, a cancellable export and PNG sequences zipped into one file (2026-09-14); next animatics and desktop packaging.
4. Animatics (done 2026-09-14): WebM recording with sound and a frame-exact PNG sequence, both driven by the same frame evaluation as playback, with progress and cancellation.
5. Desktop: choose the native shell only after measuring Windows pen input, file overwrite, audio and memory on real hardware — criteria, candidates and codec/licence research are in docs/DESKTOP.md. Offline (faster than real time) video export belongs with that work.

Do not describe phase 1 as a finished desktop application. First release has no audio or video export. Keep common actions in toolbar; advanced settings in inspector. No runtime third-party dependencies added.

## Reference research
https://www.toonboom.com/products/storyboard-pro (accessed 2026-09-13): integrated thumbnailing, timing and camera work; live panel timer with a review stage. Adaptation: one frame-based model shared by playback and paper, edits committed as reversible actions. Future tap timing must have review before applying. UI/code/assets are independently authored. Attachment guides workspace proportions only.
