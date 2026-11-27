# png-squeeze-01

[![make.fun](https://make.fun/badge/competition/png-squeeze-01)](https://make.fun/c/png-squeeze-01)
[![make.fun](https://make.fun/badge/leaderboard/png-squeeze-01)](https://make.fun/c/png-squeeze-01)
[![make.fun](https://make.fun/badge/submissions/png-squeeze-01)](https://make.fun/c/png-squeeze-01)

Squeeze screenshots into the smallest PNG, losslessly. One program
(`main.ts`, Node 22, standard library only) answers all 8 instances in one
run: it decodes each PNG to RGBA, screens the exact forms (palette by count
and by luminance, grey, RGB, RGBA, tRNS key) and per-row filter choices
(fixed, minimum-sum, fewest-pairs, brute force with a real-deflate proxy) by
zlib level 6, then re-encodes the winner's filtered data with its own
optimal-parsing DEFLATE (hash-chain LZ77, dynamic-programming optimal parse
with iterated Huffman refinement, block splitting, dynamic Huffman with
length-limited codes) and writes the PNG
(IHDR, PLTE, tRNS, IDAT, IEND only) to `/output/<id>/image.png`.

Deterministic: fixed iteration counts and block sizes, no clock, no
randomness, no network. Two runs produce byte-identical outputs.

[make.fun](https://make.fun)
