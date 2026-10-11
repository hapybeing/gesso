# Gesso

A pressure-sensitive painting studio for Android tablets, built as an installable PWA (TypeScript + WebGL2, no frameworks).

## Build
    npm install
    ./build.sh          # -> dist/
    test/all.sh 1..4    # headless tests in groups that each fit 2 minutes (Chromium + SwiftShader, synthetic pen/touch); screenshots -> shots/
    node test/perf.cjs <brushId>   # per-frame cost with a 240 Hz coalesced pen stream at 1280x800 @ DPR 2

## Deploy
Static files in dist/ (all paths relative). Hosted on GitHub Pages at hapybeing.github.io/gesso/.

## Layout
- src/engine.ts   WebGL2 layer engine: stroke coverage buffer, blend-mode compositor (dirty-rect scissored), smudge, history, export
- src/shaders.ts  GLSL (premultiplied alpha; 18 blend modes; wet edges)
- src/brushes.ts  brush presets + procedurally generated tips and paper grains
- src/stroke.ts   streamline smoothing, spacing, jitter, pressure/tilt, tapers
- src/input.ts    pointer events: pen, palm rejection, 2/3-finger taps, pinch-zoom-rotate, touch-hold eyedropper
- src/main.ts     UI shell (brush library, brush studio, colour wheel, layers, menus) and tool wiring
- src/pressureui.ts  pressure curve editor + draw-to-calibrate
- src/store.ts, src/autosave.ts, src/gallery.ts  IndexedDB persistence, debounced autosave, gallery screen
- src/gessofile.ts   .gesso (OpenRaster-compatible zip): own zip writer/reader and PNG encoder; worker.ts/workerclient.ts encode off-thread
- src/quickshape.ts, src/shapetool.ts  hold-to-snap shape recognition and editing
- src/symmetry.ts    symmetry guide and dab replication
- src/transformtool.ts  transform box (image import, selection/layer transform): uniform, free, distort (homography), warp (Bézier patch)
- src/selecttool.ts  selection tools (rect, ellipse, freehand/polygon, automatic flood fill)
- src/timelapse.ts   time-lapse recorder (per-step capture → WebCodecs), replay screen, export; src/video.ts codec choice/encode/decode/transcode; src/mux.ts own MP4 + WebM muxers
- src/animation.ts   animation assist: frames, timeline, onion skin, light table, playback; src/animexport.ts GIF / MP4 / WebM / PNG-sequence export; src/gif.ts own GIF encoder (palette, dither, LZW), run in worker.ts
- src/dom.ts         shared DOM helpers
- public/         index.html, style.css, manifest, service worker, icons

Original clean-room code. Not affiliated with any other painting app.
