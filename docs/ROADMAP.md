# contE roadmap

2026-09-13: audited all repository files and branches: main contained README only. No application, dependencies, migrations or tests existed.

1. First usable foundation (this iteration): browser-hosted local editor, Scene/Shot/Panel model, frame timing, strokes, selection, split/merge, history, save/load, camera interpolation, timeline and playback.
2. Paper production (this iteration): shared project-derived pagination, configurable columns/rows/margins/type/header, camera notation, print/PDF via print dialog, numbered PNG pages.
3. Production reliability: crash recovery and autosave in IndexedDB with a separated asset store and schema migration, then image import, brush/eraser/pressure drawing, panel range selection and drag reordering, resizable panes (all done 2026-09-13); next camera tracks and a separated timeline engine, waveform/audio editing and synchronized playback, export cancellation.
4. Desktop and animatics: choose native shell after Windows pen/audio benchmarks; packaged installers, native PDF/video exporters, codec/license review, end-to-end 500-panel media-heavy benchmark.

Do not describe phase 1 as a finished desktop application. First release has no audio or video export. Keep common actions in toolbar; advanced settings in inspector. No runtime third-party dependencies added.

## Reference research
https://www.toonboom.com/products/storyboard-pro (accessed 2026-09-13): integrated thumbnailing, timing and camera work; live panel timer with a review stage. Adaptation: one frame-based model shared by playback and paper, edits committed as reversible actions. Future tap timing must have review before applying. UI/code/assets are independently authored. Attachment guides workspace proportions only.
