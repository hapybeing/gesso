# Gesso — Plan
Goal: Procreate-class painting + animation PWA for an Android tablet (Brave), touch + stylus. Quality over speed.
Standard: a test must pass AND the result must feel right compared with Procreate's behaviour. Review pass after each milestone and after every 3–4 major features (see REVIEW.md).

## Hosting
- Primary: GitHub Pages at hapybeing.github.io/gesso. Waiting on him to create the repo and turn Pages on. Builds go to main (root); source goes to the `source` branch.
- Surge is blocked (see the project notes).

## M1 — Painting core [built 2026-10-12, reviewed R1 2026-10-12]
Engine, 18 brushes, studio, layers/blends/clip/alpha-lock, colour, undo/redo, gestures, PNG, PWA.
Known debt: full-canvas textures rather than tiles.

## M1.5 — Review R1 fixes (before M2)
- [x] Re-read engine/stroke/input, list rough edges in REVIEW.md
- [x] Profile on a 1280x800 tablet viewport at DPR 2: 120 Hz-style pen stream (getCoalescedEvents), measure ms per frame for dabs + composite
- [x] Brush feel against Procreate: pressure curve UI, stabilisation vs streamline, taper and speed response, smoothing lag
- [x] UI polish: one-handed reach, sidebar size/opacity sliders, quick undo button, 44px targets

## M2 — Workflow [done 2026-10-12, reviewed R2]
- [x] IndexedDB autosave (debounced, per-layer dirty layers, bit-exact) + Gallery (thumbnails, new/duplicate/delete/rename, canvas presets); opens to last artwork; beforeunload nag removed
- [x] Native .gesso format (zip: manifest.json + layer PNGs, also a valid OpenRaster file) export/import; .ora import
- [x] Image import as layer, with transform box (move, uniform/free scale, rotate, pinch, flip, fit, smooth/sharp, snapping)
- [x] Shape snapping (hold at stroke end: line, arc, polyline, ellipse/circle, rectangle/square, polygon; rubber-band, finger = perfect, edit handles, Freehand revert)
- [x] Selection: freehand (+polygon taps), rectangle, ellipse, automatic (wand, live threshold); add/subtract; mask-aware painting/erasing/smudge; invert/feather/fill/clear/copy-paste
- [x] Transform: uniform + free scale, rotate, pinch, flip, rotate 90, fit; trilinear/bicubic/nearest; selection or whole layer, one undo step
- [x] Transform: distort (perspective) and warp
- [x] Selection: grow/shrink + feather with live preview (Refine edge)
- [x] Symmetry: vertical, horizontal, quadrant, radial (2–32, mirror or rotational), assisted drawing toggle, draggable/rotatable guide, saved per artwork
- [x] Timelapse: record every step, replay with scrubbing, export MP4/WebM (full + ~30 s) via WebCodecs + own muxers, MediaRecorder fallback
- [x] Review R2-lite (part A)
- [x] Review R2 (full; on-device feel checks still pending)

## M3 — Animation
- [ ] Animation assist: frames = layers/groups, timeline strip, onion skin (count, opacity, colours), FPS, loop/ping-pong/one-shot, hold frames
- [ ] Playback at FPS, export GIF (own encoder in a worker), MP4/WebM, PNG sequence
- [ ] Review R3

## Later
True tiled canvases (16k), layer groups, adjustments (HSB, curves, Gaussian blur, liquify), text, reference window, pressure curve per pen.
