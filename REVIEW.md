# Gesso — Review log
Each entry: date, scope, what was measured, what felt wrong, what got fixed, what was deferred.

## R0 — M1 build tests (2026-10-12)
- Synthetic test passes, with no console errors. 14 strokes take ~4.6 s under SwiftShader (CPU, not representative of a tablet's GPU). 600-sample wet stroke ~488 ms on CPU.
- Gestures: 2-finger undo, 3-finger redo, pinch/rotate, and palm rejection after pen detection all OK.
- Watercolour was too grainy, so I retuned it.
