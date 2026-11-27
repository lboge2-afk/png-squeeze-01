# png-squeeze-01

[![make.fun](https://make.fun/badge/competition/png-squeeze-01)](https://make.fun/c/png-squeeze-01)
[![make.fun](https://make.fun/badge/leaderboard/png-squeeze-01)](https://make.fun/c/png-squeeze-01)
[![make.fun](https://make.fun/badge/submissions/png-squeeze-01)](https://make.fun/c/png-squeeze-01)

Squeeze screenshots into the smallest PNG, losslessly. One program
(`main.ts`, Node 22, standard library only) answers all 8 instances in one
run: it decodes each PNG to RGBA, screens the exact forms (palette by count
and by luminance, grey, RGB, RGBA, tRNS key) and per-row filter choices
(fixed, minimum-sum, fewest-pairs, brute force with a real-deflate proxy) by
zlib level 6, then looks for a macro-band (one filter over a large smooth
opening region, found automatically from the row roughness — see
`band.mjs`), then re-encodes the winner's filtered data with its own
optimal-parsing DEFLATE (hash-chain LZ77, dynamic-programming optimal parse
with iterated Huffman refinement, block splitting, dynamic Huffman with
length-limited codes) and writes the PNG
(IHDR, PLTE, tRNS, IDAT, IEND only) to `/output/<id>/image.png`.

The DEFLATE hot loop runs as WebAssembly compiled from our own
AssemblyScript source (`deflate.ts`, built with `node build-wasm.mjs`;
the committed `deflate.wasm` and the base64 blob in `wasm-b64.mjs` are
that build). The WASM core buys a deeper search (two-level hash, MAX_CAND
12, 5 DP passes) inside the 60 s wall; the pure-JS `deflate.mjs` stays as
a fallback, and every WASM stream is round-trip checked before use.

v2.1 (grade-local 763,178, +2,048 over v2): the WASM core now optimises
the Huffman header (16 RLE variants for the code-length table, exact
dynamic-vs-fixed choice instead of a +400 heuristic) and splits blocks
by measured cost — a cost-based recursive split search over near-optimal
tokens (2 DP passes), not a greedy parse (the greedy tokens misjudge
splits and the first version lost 4,336 points). And the search is
allocated per instance by the points-per-byte rule (see `WASM_TIERS` in
`deflate-wasm.mjs`): bytes are worth ~14x more on the smallest outputs
than on the biggest, so flat/small outputs get the deep search and the
big ones run cheaper. The tier is picked from the measured sizes only
(filtered length + zlib-6 baseline length) — deterministic, no clock.

v2.5 (grade-local 760,921) is the wall-safe revision of v2.1. The
practice set is the FASTEST draw, not representative: 6/6 random sets
drawn from other seeds ran 60–87 s with v2.1, and a run past the 60 s
wall earns nothing (RULES.txt). So the tiers were capped for the wall:
chain4 at most 1024 (the 2048/4096 chains are what blow the wall on
repetitive flat content), dpPasses 6/5/4/3 by tier, a CHEAPEST tier
(chain4 512, 2 passes) for huge outputs (zlib-6 ≥ 300 KB — the slowest
instances and the cheapest bytes), and the macro-band refinement grid
coarsened from 20-row to 40-row steps (16 → 8 zlib-6 calls). The wall
fix costs ~2,260 practice points vs v2.1, but a 763 K entry that times
out scores 0 and a 761 K entry that completes scores 761 K. Standalone
wall (practice) ~46 s; worst measured draw ~62 s (seed2) — the wall is
content-dependent and no fixed tier config can guarantee it, so the
residual risk is disclosed, not hidden.

Deterministic: fixed iteration counts and block sizes, no clock, no
randomness, no network. Two runs produce byte-identical outputs.

[make.fun](https://make.fun)
