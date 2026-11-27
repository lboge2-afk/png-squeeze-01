// png-squeeze-01 entry: the WebAssembly DEFLATE core, loaded from the
// base64 blob in wasm-b64.mjs (compiled from deflate.ts, our own
// AssemblyScript port of deflate.mjs). Same search as the JS deflate, but
// the chain-walking hot loop runs at near-native speed, which buys the
// deeper search the JS version cannot afford inside the 60 s wall:
// two-level hash (chain4 1024, chain3 16), MAX_CAND 12, 5 DP passes,
// 200 KB blocks. Deterministic: fixed iteration counts, operation-counted
// budgets, no clock, no randomness. If the WASM cannot load or returns an
// error, deflateWasm returns null and the caller falls back to the JS
// deflate in deflate.mjs.

import { WASM_B64 } from './wasm-b64.mjs';

/** The search configuration (matches the measured sweep: I = dpPasses 5 + maxCand 12). */
export const WASM_CONFIG = Object.freeze({
  chain4Limit: 1024,
  chain3Limit: 16,
  maxCand: 12,
  dpPasses: 5,
  blockSize: 200000,
});

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
 * Deflate `data` with the WASM core. Returns the zlib stream (Uint8Array)
 * or null when the WASM is unavailable or reports an error. The caller
 * round-trips the result and falls back to the JS deflate on any failure.
 */
export function deflateWasm(data) {
  const w = init();
  if (!w) return null;
  try {
    const mem = new Uint8Array(w.memory.buffer);
    const inPtr = w.inputPtr();
    if (data.length > 0x1000000) return null; // larger than the WASM input region
    mem.set(data, inPtr);
    const outLen = w.deflateAll(
      data.length,
      WASM_CONFIG.chain4Limit,
      WASM_CONFIG.chain3Limit,
      WASM_CONFIG.maxCand,
      WASM_CONFIG.dpPasses,
      WASM_CONFIG.blockSize,
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
