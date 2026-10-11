# Gesso

A pressure-sensitive painting studio for Android tablets, built as an installable PWA (TypeScript + WebGL2, no frameworks).

## Build
    npm install
    ./build.sh          # -> dist/
    node test/run.cjs   # headless Chromium smoke test with synthetic pen/touch input (needs /usr/bin/chromium)

## Deploy
    npx surge dist gesso-paint.surge.sh

## Layout
- src/engine.ts   WebGL2 layer engine: stroke coverage buffer, blend-mode compositor (dirty-rect scissored), smudge, history, export
- src/shaders.ts  GLSL (premultiplied alpha; 18 blend modes; wet edges)
- src/brushes.ts  brush presets + procedurally generated tips and paper grains
- src/stroke.ts   streamline smoothing, spacing, jitter, pressure/tilt, tapers
- src/input.ts    pointer events: pen, palm rejection, 2/3-finger taps, pinch-zoom-rotate, touch-hold eyedropper
- src/main.ts     UI (brush library, brush studio, colour wheel, layers, menus)
- public/         index.html, style.css, manifest, service worker, icons

Original clean-room code. Not affiliated with any other painting app.
