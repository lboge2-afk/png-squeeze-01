// png-squeeze-01 entry: squeeze screenshots into the smallest PNG, losslessly.
// One program answers all 8 instances in one run (60 s wall, 1 CPU, 512 MB).
//
// Pipeline per instance:
//   1. Decode the stored PNG to RGBA (own decoder).
//   2. Screen the exact forms (palette by count/luminance, grey, RGB, RGBA,
//      tRNS key) and per-row filter choices (fixed, minimum-sum, fewest-pairs,
//      brute force) by zlib level 6; keep the cheapest.
//   3. Re-encode the winner's filtered data with the own optimal-parsing
//      DEFLATE (hash-chain LZ77, dynamic-programming optimal parse with
//      iterated Huffman refinement, block splitting, dynamic Huffman).
//      The optimal stream is kept only when it beats the screened zlib
//      stream, so the answer never loses to the screen.
//   4. Write the PNG (IHDR, PLTE, tRNS, IDAT, IEND only) to /output/<id>/image.png.
//
// Deterministic: fixed iteration counts and block sizes, no clock, no
// randomness, no environment reads beyond the input/output directories.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { decodePng, ihdrOf, pngOf } from './png.mjs';
import { screenCandidates } from './screen.mjs';
import { deflate } from './deflate.mjs';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The PNG of an image of `form` whose IDAT holds the zlib stream `idat`. */
function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  // Screen forms and filters by zlib level 6; the winner is re-encoded with
  // the optimal-parsing deflate.
  const cands = screenCandidates(image.rgba, image.width, image.height, { level: 6, brute: true });
  const best = cands[0];
  const optimal = deflate(best.data);
  const idat = optimal.length < best.zlibLen
    ? optimal
    : deflateSync(best.data, { level: 6, memLevel: 8 });
  const file = pngOfForm(image.width, image.height, best.form, idat);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), file);
}
