// png-squeeze-01 entry: squeeze screenshots into the smallest PNG, losslessly.
// One program answers all 8 instances in one run (60 s wall, 1 CPU, 512 MB).
//
// Pipeline per instance:
//   1. Decode the stored PNG to RGBA (own decoder).
//   2. Screen the exact forms (palette by count/luminance, grey, RGB, RGBA,
//      tRNS key) and per-row filter choices (fixed, minimum-sum, fewest-pairs,
//      brute force) by zlib level 6; keep the cheapest.
//   3. Macro-band: when the image opens with a large smooth region, one
//      filter over that whole region (found automatically from the row
//      roughness, refined by zlib) can beat the screen winner — see band.mjs.
//   4. Re-encode the winner's filtered data with the own optimal-parsing
//      DEFLATE. The hot loop (hash-chain LZ77 match finding) runs as
//      WebAssembly compiled from our own AssemblyScript source (deflate.ts),
//      which buys a deeper search (MAX_CAND 12, 5 DP passes) inside the
//      wall; the JS deflate in deflate.mjs stays as a fallback. The optimal
//      stream is kept only when it beats the screened zlib stream, so the
//      answer never loses to the screen. A WASM stream is round-trip
//      checked before it is used; on any failure the JS deflate is used.
//   5. Write the PNG (IHDR, PLTE, tRNS, IDAT, IEND only) to /output/<id>/image.png.
//
// Deterministic: fixed iteration counts and block sizes, no clock, no
// randomness, no environment reads beyond the input/output directories.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { decodePng, ihdrOf, pngOf } from './png.mjs';
import { screenCandidates } from './screen.mjs';
import { deflate } from './deflate.mjs';
import { deflateWasm } from './deflate-wasm.mjs';
import { findTopBand } from './band.mjs';

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
  let best = cands[0];
  // A smooth opening region may want one filter over the whole region.
  const band = findTopBand(best, image.width, image.height);
  if (band !== null) best = { form: best.form, choice: `band-f${band.filter}@${band.boundary}`, data: band.data, bytes: band.zlibLen, zlibLen: band.zlibLen };
  // Optimal-parse deflate: WASM core first, JS fallback on any failure.
  let optimal = deflateWasm(best.data);
  if (optimal !== null) {
    // Round-trip check: the WASM stream must inflate back to the input.
    let ok = false;
    try { ok = Buffer.compare(inflateSync(optimal), Buffer.from(best.data)) === 0; } catch (e) { ok = false; }
    if (!ok) optimal = null;
  }
  if (optimal === null) optimal = deflate(best.data);
  const idat = optimal.length < best.zlibLen
    ? optimal
    : deflateSync(best.data, { level: 6, memLevel: 8 });
  const file = pngOfForm(image.width, image.height, best.form, idat);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), file);
}
