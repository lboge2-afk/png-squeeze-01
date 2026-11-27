// png-squeeze-01 entry: macro-band filters. A screenshot often opens with a
// large smooth region (a gradient desktop background, a flat sky) where one
// filter (Up or Paeth) beats the screen winner, while the rest of the image
// wants the winner's filter. A per-row choice (the screen's 'brute') cannot
// see this: it changes filter row by row, which breaks the cross-row
// matches the DEFLATE stage needs. A macro-band keeps ONE filter over the
// whole smooth region, so the matches survive.
//
// Detection is automatic and deterministic (it must work on the scored set,
// which is a different draw): the per-row vertical roughness (mean |cur -
// prev|) is averaged over 20-row blocks; the first block whose average
// exceeds 2.0 marks the end of the smooth top. The boundary is then refined
// by zlib level 6 over a small grid around it, and the band is accepted
// only when zlib improves by more than 300 bytes — otherwise the winner
// stands. The band is measured by zlib, never by the clock.

import { deflateSync } from 'node:zlib';
import { filterRow } from './png.mjs';

/** Mean |cur - prev| per sample, averaged over 20-row blocks. */
function blockRoughness(samples, width, height, bpp) {
  const stride = width * bpp;
  const blocks = Math.ceil(height / 20);
  const rough = new Float64Array(blocks);
  for (let y = 1; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = samples.subarray((y - 1) * stride, y * stride);
    let sum = 0;
    for (let i = 0; i < stride; i++) sum += Math.abs(cur[i] - prev[i]);
    rough[(y / 20) | 0] += sum / stride;
  }
  for (let b = 0; b < blocks; b++) {
    const rows = Math.min(20, height - b * 20);
    rough[b] /= Math.max(1, rows - (b === 0 ? 1 : 0));
  }
  return rough;
}

/** The winner's filtered data with rows [0, B) rebuilt with `topFilter`. */
export function bandedData(winnerData, samples, width, height, bpp, topFilter, B) {
  const data = new Uint8Array(winnerData);
  const stride = width * bpp;
  for (let y = 0; y < B; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    data[at] = topFilter;
    filterRow(topFilter, cur, prev, bpp, data.subarray(at + 1, at + 1 + stride));
  }
  return data;
}

const SMOOTH_THRESHOLD = 2.0; // mean |cur - prev| per sample
const MIN_TOP = 40; // the smooth top must be at least this many rows
const ACCEPT_MARGIN = 300; // zlib must improve by more than this many bytes

/**
 * Find a top macro-band for the screen winner. Returns
 * { data, zlibLen, filter, boundary } when a band beats the winner by more
 * than ACCEPT_MARGIN zlib bytes, else null. `winner` is a screenCandidates
 * entry { form, data, zlibLen }; `width`/`height` are the image size.
 */
export function findTopBand(winner, width, height) {
  const { form } = winner;
  const rough = blockRoughness(form.samples, width, height, form.bpp);
  let B0 = height;
  for (let b = 0; b < rough.length; b++) {
    if (rough[b] > SMOOTH_THRESHOLD) { B0 = b * 20; break; }
  }
  if (B0 < MIN_TOP || B0 >= height) return null;
  let best = null;
  for (const topFilter of [2, 4]) {
    for (let B = Math.max(MIN_TOP, B0 - 20); B <= Math.min(height, B0 + 120); B += 20) {
      const data = bandedData(winner.data, form.samples, width, height, form.bpp, topFilter, B);
      const zlibLen = deflateSync(data, { level: 6, memLevel: 8 }).length;
      if (zlibLen < winner.zlibLen - ACCEPT_MARGIN && (best === null || zlibLen < best.zlibLen)) {
        best = { data, zlibLen, filter: topFilter, boundary: B };
      }
    }
  }
  return best;
}
