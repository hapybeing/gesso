# Gesso — Review log
Each entry: date, scope, what was measured, what felt wrong, what got fixed, what was deferred.

## R0 — M1 build tests (2026-10-12)
- Synthetic test passes, with no console errors. 14 strokes take ~4.6 s under SwiftShader (CPU, not representative of a tablet's GPU). 600-sample wet stroke ~488 ms on CPU.
- Gestures: 2-finger undo, 3-finger redo, pinch/rotate, and palm rejection after pen detection all OK.
- Watercolour was too grainy, so I retuned it.

## R1 — M1 review: engine, stroke, input, UI (2026-10-12)
**Bar (how the best apps do it).** Procreate: StreamLine (speed-dependent pull with catch-up on lift), separate Stabilisation and Motion filtering, 250-step undo, two-finger tap undo and *two-finger hold for rapid undo*, size/opacity side sliders, pressure curve edited per device. Krita: several smoothing modes (basic, weighted, stabiliser with delay distance, pixel-based). Clip Studio: stabilisation plus "post-correction" and speed-based smoothing; draws a sample stroke to *adjust pressure from your own strokes*. Infinite Painter: predictive stroke drawing and pressure calibration by drawing. The common thread: smoothing is time/speed-based, not per-event, and pressure is tuned from real strokes.

**Measured** (1280×800 @ DPR 2, 2560×1600 canvas, 3 layers, 240 Hz pen delivered as rAF-aligned pointermoves carrying 4 coalesced samples; SwiftShader CPU raster, so absolute numbers are ~50–100× a tablet GPU — compare relative costs. `node test/perf.cjs <brush>`):
| | before | after |
|---|---|---|
| input handler per frame (Studio Ink, 80 dabs) | 1.5 ms | 0.4 ms |
| render per frame | 48 ms | 47 ms (4.1 Mpx full-screen present dominates; composite only 0.07 Mpx/frame) |
| stroke end (warm, 2050×1020 doc-px bbox) | 99 ms, incl. two blocking `readPixels` of 8 MB | 54 ms, zero readbacks |
| first stroke of a session | +100–350 ms shader JIT | pre-warmed at document creation |
| 14-stroke smoke test | 6.6 s | 1.9 s |
On a real GPU the old stroke end stalled the pipeline twice per stroke (sync readback); the new one is three scissored GPU passes.

**Rough edges found → fixed**
- Stroke end read the whole bbox back to the CPU twice (before + after) and baked the *full canvas* → GPU stash of only the bbox (blit), scissored bake, swap-semantics undo (one buffer per step serves undo and redo, half the memory). Stashes beyond a 160 MB GPU budget migrate to CPU memory by async PBO + fence readback in idle frames, never stalling. Clear/Fill/Merge undo uses the same stash.
- Smoothing was a per-event exponential, so lag and strength changed with the device's sample rate and cut corners at speed (0.7 smoothing, 60 Hz, fast: 5.3 px RMS deviation, 48 px lag) → time-based adaptive filter (heavy when slow, light when fast; speed measured in *screen* px so it feels the same at any zoom) plus quadratic mid-point curve interpolation between samples (no polygonal corners at 60 Hz). Same case now 2.0 px deviation, 26 px lag; slow-stroke jitter down 25–45 %. Remaining lag at low smoothing is mostly the half-sample of curve interpolation (≈3 px at 240 Hz).
- Pressure was a single gamma slider → Bézier curve editor with draggable handles, Soft/Linear/Firm presets, live pen dot, and **draw-to-calibrate**: scribble in a pad, Gesso fits the curve to the quantiles of your own pressure (light hand: 0.25 → 0.47) and shows the histogram behind the curve.
- Tapers were fixed doc px → scale with brush size relative to its preset.
- Pen eraser end / eraser button (buttons bit 32) now erases without changing tool.
- Two-finger hold = rapid undo (accelerating), so deep undo no longer means dozens of taps. Undo reach 120 → 250 steps.
- Mipmaps were regenerated on every present when zoomed out, even pan-only frames → only when the composite changed.
- Touch targets: small icon buttons 36 → 44 px, chips 44 px min, rail sliders 40×180.
- Brush settings wrote localStorage on every slider move → debounced.
- "Oil Bristle" tip had a bald band (random hair placement) → stratified hairs.
- In-app label "StreamLine" (another app's feature name) → "Smoothing".

**Deferred:** tiled canvases; predicted events (getPredictedEvents) for a provisional stroke tip; per-pen curves; caching below/above-layer composites during a stroke (not needed: composite is 0.07 Mpx/frame).
