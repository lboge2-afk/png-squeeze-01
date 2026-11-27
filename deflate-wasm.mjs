// png-squeeze-01 entry: the WebAssembly DEFLATE core, loaded from the
// base64 blob in wasm-b64.mjs (compiled from deflate.ts, our own
// AssemblyScript port of deflate.mjs). Same search as the JS deflate, but
// the chain-walking hot loop runs at near-native speed, which buys the
// deeper search the JS version cannot afford inside the 60 s wall.
// v2.1: the core now also optimises the Huffman header (16 RLE variants +
// exact dynamic-vs-fixed choice) and splits blocks by measured cost
// (near-optimal search tokens, not a greedy parse). Deterministic: fixed
// iteration counts, operation-counted budgets, no clock, no randomness.
// If the WASM cannot load or returns an error, deflateWasm returns null
// and the caller falls back to the JS deflate in deflate.mjs.

import { WASM_B64 } from './wasm-b64.mjs';

/** The default search configuration (v2: I = dpPasses 5 + maxCand 12). */
export const WASM_CONFIG = Object.freeze({
  chain4Limit: 1024,
  chain3Limit: 16,
  maxCand: 12,
  dpPasses: 5,
  blockSize: 200000,
  maxParts: 4,
});

/**
 * Per-instance search tiers (v2.1, measured on the practice set). Bytes are
 * worth ~14x more on the smallest outputs than on the biggest instance, so
 * the deep search goes to small outputs and the big ones run cheaper. The
 * tier is picked from the measured sizes only (filtered length + zlib-6
 * baseline length) — deterministic, no clock. maxCand 16 is free everywhere.
 * DEEP: tiny output (zlib-6 <22 KB) — flat. v2.3: chain4 capped at 1024
 * (the 2048/4096 chains are what blow the wall on repetitive flat
 * content — seed1's flat i001 took 12.2 s at chain4 4096); the deep
 * search now buys only the extra DP pass (6 vs 5) and maxCand 16.
 * MED: small output (22–30 KB) — chain4 1024, 5 passes.
 * STD_DP8: medium output, medium stream — 5 passes (same as STD now;
 * the extra passes did not pay for their wall on hard draws).
 * STD: the alpha instance whose output is small but whose matches are
 * sparse — full search, cheapening it loses ~12 points.
 * MILD_CHEAP: big output (97–168 KB) — chain4 768 + 4 passes: ~1–2 s
 * faster, loses <1 point (on the alpha instance it even gains a little).
 * Never chain4 2048 on the biggest/noisiest instance — it loses bytes.
 */
export const WASM_TIERS = Object.freeze({
  DEEP: Object.freeze({ chain4Limit: 1024, chain3Limit: 16, maxCand: 16, dpPasses: 6, blockSize: 200000, maxParts: 4 }),
  MED: Object.freeze({ chain4Limit: 1024, chain3Limit: 16, maxCand: 16, dpPasses: 5, blockSize: 200000, maxParts: 4 }),
  STD_DP8: Object.freeze({ chain4Limit: 1024, chain3Limit: 16, maxCand: 16, dpPasses: 4, blockSize: 200000, maxParts: 4 }),
  STD: Object.freeze({ chain4Limit: 1024, chain3Limit: 16, maxCand: 16, dpPasses: 4, blockSize: 200000, maxParts: 4 }),
  MILD_CHEAP: Object.freeze({ chain4Limit: 768, chain3Limit: 16, maxCand: 16, dpPasses: 3, blockSize: 200000, maxParts: 4 }),
  // Huge output (zlib-6 >= 300 KB): the slowest instances (seed2's i002/
  // i006 take 6–11 s even at CHEAP) and the cheapest bytes (0.45 pts/B).
  // chain4 512 + 2 passes: the wall saving is worth more than the few
  // points these bytes are worth.
  CHEAPEST: Object.freeze({ chain4Limit: 512, chain3Limit: 16, maxCand: 12, dpPasses: 2, blockSize: 200000, maxParts: 4 }),
});

/** Pick a search tier from the instance's measured sizes (see WASM_TIERS).
 * NOTE: zlibLen here is the zlib-6 baseline length, which runs ~15–25%
 * larger than our WASM deflate length, so the thresholds are set against
 * zlib-6 lengths (flat i005 measures 18,540, not 15,064). */
export function wasmConfigFor(dataLen, zlibLen) {
  if (zlibLen >= 300000) return WASM_TIERS.CHEAPEST;
  if (zlibLen < 22000) return WASM_TIERS.DEEP;
  if (zlibLen < 30000) return WASM_TIERS.MED;
  if (dataLen >= 3000000) return zlibLen >= 70000 ? WASM_TIERS.MILD_CHEAP : WASM_TIERS.STD;
  if (dataLen >= 2000000) return zlibLen >= 100000 ? WASM_TIERS.MILD_CHEAP : WASM_TIERS.STD_DP8;
  return WASM_TIERS.MILD_CHEAP;
}

let wasm = null; // { deflateAll, inputPtr, outputPtr, memory } | false (failed)
let tried = false;

function init() {
  if (tried) return wasm;
  tried = true;
  try {
    const bytes = Buffer.from(WASM_B64.replace(/\s/g, ''), 'base64');
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {
      env: {
        abort() { throw new Error('wasm abort'); },
      },
    });
    const { deflateAll, inputPtr, outputPtr, memory } = instance.exports;
    wasm = { deflateAll, inputPtr, outputPtr, memory };
  } catch (e) {
    wasm = false;
  }
  return wasm;
}

/**
 * Deflate `data` with the WASM core. `config` is an optional search tier
 * (see wasmConfigFor); when omitted the default WASM_CONFIG is used.
 * Returns the zlib stream (Uint8Array) or null when the WASM is unavailable
 * or reports an error. The caller round-trips the result and falls back to
 * the JS deflate on any failure.
 */
export function deflateWasm(data, config) {
  const w = init();
  if (!w) return null;
  const cfg = config || WASM_CONFIG;
  try {
    const mem = new Uint8Array(w.memory.buffer);
    const inPtr = w.inputPtr();
    if (data.length > 0x1000000) return null; // larger than the WASM input region
    mem.set(data, inPtr);
    const outLen = w.deflateAll(
      data.length,
      cfg.chain4Limit,
      cfg.chain3Limit,
      cfg.maxCand,
      cfg.dpPasses,
      cfg.blockSize,
      cfg.maxParts,
    );
    if (outLen < 0 || outLen > data.length + 1024) return null;
    const outPtr = w.outputPtr();
    return new Uint8Array(mem.subarray(outPtr, outPtr + outLen));
  } catch (e) {
    return null;
  }
}

/** True when the WASM core loaded and is ready. */
export function wasmReady() {
  return init() !== false;
}
