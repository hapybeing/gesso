# Gesso — Plan
Goal: Procreate-class painting + animation PWA for an Android tablet (Brave), touch + stylus. Quality over speed.
Standard: a test must pass AND the result must feel right compared with Procreate's behaviour. Review pass after each milestone and after every 3–4 major features (see REVIEW.md).

## Hosting
- Primary: GitHub Pages at hapybeing.github.io/gesso. Waiting on him to create the repo and turn Pages on. Builds go to main (root); source goes to the `source` branch.
- Surge is blocked (see the project notes).

## M1 — Painting core [built 2026-10-12, review R1 pending]
Engine, 18 brushes, studio, layers/blends/clip/alpha-lock, colour, undo/redo, gestures, PNG, PWA.
Known debt: full-canvas textures rather than tiles; no persistence; beforeunload nag.

## M1.5 — Review R1 fixes (before M2)
- [ ] Re-read engine/stroke/input, list rough edges in REVIEW.md
- [ ] Profile on a 1280x800 tablet viewport at DPR 2: 120 Hz-style pen stream (getCoalescedEvents), measure ms per frame for dabs + composite
- [ ] Brush feel against Procreate: pressure curve UI, stabilisation vs streamline, taper and speed response, smoothing lag
- [ ] UI polish: one-handed reach, sidebar size/opacity sliders, quick undo button, 44px targets

## M2 — Workflow
- [ ] IndexedDB autosave (debounced, per-layer dirty tiles) + Gallery (thumbnails, new/duplicate/delete/rename, canvas presets)
- [ ] Native .gesso format (zip: manifest.json + layer PNGs) save/load; PSD-free
- [ ] Image import as layer, with transform
- [ ] QuickShape (hold at stroke end: line, ellipse, rectangle, polyline; edit handles)
- [ ] Selection: freehand, rectangle, ellipse, magic wand; mask-aware painting; invert/feather/clear
- [ ] Transform: free, uniform, distort, warp-lite; bilinear/bicubic; flip/rotate 90
- [ ] Symmetry: vertical, horizontal, quadrant, radial (n), rotational toggle
- [ ] Timelapse: record strokes/ops, replay, export WebM/MP4 via MediaRecorder/WebCodecs
- [ ] Review R2

## M3 — Animation
- [ ] Animation assist: frames = layers/groups, timeline strip, onion skin (count, opacity, colours), FPS, loop/ping-pong/one-shot, hold frames
- [ ] Playback at FPS, export GIF (own encoder in a worker), MP4/WebM, PNG sequence
- [ ] Review R3

## Later
True tiled canvases (16k), layer groups, adjustments (HSB, curves, Gaussian blur, liquify), text, reference window, pressure curve per pen.
