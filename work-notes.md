# M4 notes (scratch for REVIEW)
## Tiles
- 48 frames 1080p ball: whole-layer 379.7 MB -> 23.9 MB (63 tiles, 1 page + 1 resident); capacity under 560 MB budget: 66 -> ~1549 frames
- 4096² 16 layers each one dab: 1024 MB whole (old cap 4 layers) -> 96 MB
- composite hash identical resident vs tiled; undo/redo across eviction restores exactly
- autosave: stroke on 4096² doc writes 4 tiles / 18.8 KB / 82-136 ms (before: whole 64 MB layer readback + deflate). bigdoc 3840x2160x5: save-all 778 ms longest task 67 ms (was 3.9 s / 2.7 s task); single stroke 5 tiles 22.6 KB.
- bugs found: reduce pass maxed alpha=1 of r1 (every tile looked used) -> output vec4(m); materialise inside draw setup clobbered FB/texture bindings (feedback loop warning, selection fill broken) -> save/restore GL state; canGrow counted transient residents -> atlas + 2 working layers; bursts making many residents -> sync LRU eviction under pressure.
- SwiftShader: first sync point absorbs the CPU raster backlog (2.2 s drain measured with nothing but a fill pending), so the eviction now carries the long task the first save used to.
- 24 layers @4096² crashed headless SwiftShader during first save (host memory); 16 fine.
