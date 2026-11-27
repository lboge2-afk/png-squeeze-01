// png-squeeze-01 v2: optimal-parsing DEFLATE in AssemblyScript (own code).
// Faithful port of the entry's deflate.mjs (v1.2, pure JS) to WebAssembly so
// the match-finding runs at near-native speed. main.ts calls deflateAll() once
// per instance; the JS side keeps the screen, the PNG writer and the zlib
// fallback. Deterministic: fixed iteration counts, no clock, no randomness,
// no environment reads. All state lives in fixed regions of linear memory;
// the module makes (almost) no AssemblyScript allocations in the hot path.
//
// Memory layout (chained constants below, all offsets in bytes):
//   IN      filtered input data (max 4,000,000 bytes)
//   OUT     zlib stream output (capacity 2*inLen + 65536)
//   HEAD    4-byte hash heads, HEAD4 4-byte hash heads (262144 i32 each)
//   PREV    3-byte hash prev links, PREV4 4-byte hash prev links
//           (circular buffers, 65536 i32 each — see note in findCandidates)
//   COST    DP cost array f64 (BLOCK_CAP+1)
//   CLEN    DP choice lengths i16, CDIST DP choice distances i32
//   CAND    packed candidates i32 (len<<16 | dist), BLOCK_CAP x CAND_CAP
//   CCNT    candidate counts u8
//   TOKA/TOKB  current pass tokens (len-or-lit, dist-or-0)
//   BTOKA/BTOKB best pass tokens
//   FREQ    lit/dist frequencies, BESTFREQ best pass frequencies
//   LENS    length arrays (lit/dist, cost model, best)
//   CTAB    cost tables (lit/len/dist, f64)
//   HEAP    Huffman heap scratch
//   CLSYMS  code-length RLE symbols scratch

const WINDOW: i32 = 32768;
const MAX_MATCH: i32 = 258;
const MIN_MATCH: i32 = 3;
const HASH_BITS: i32 = 18;
const HASH_SIZE: i32 = 1 << HASH_BITS;
const HASH_MASK: i32 = HASH_SIZE - 1;
const BLOCK_CAP: i32 = 200000;
const CAND_CAP: i32 = 16;
const PREV_CAP: i32 = 65536;
const PREV_MASK: i32 = PREV_CAP - 1;
const IN_MAX: i32 = 4000000;

// --- layout (chained so the regions can never overlap by an arithmetic slip)
// IN_PTR starts at 1 MiB, NOT at 64 KiB: the AssemblyScript runtime places
// its own module-level array buffers (the DEFLATE tables, ~400 KiB) on the
// heap right after the static data segment, so a low fixed region would be
// overwritten by mem.set() from JS and corrupt the tables (found by a
// __set trap in initTables on the first real instance).
const IN_PTR: usize = 0x100000;
const OUT_PTR: usize = IN_PTR + 0x400000; // 4 MiB input region
const HEAD_PTR: usize = OUT_PTR + 0x800000; // 8 MiB output region
const HEAD4_PTR: usize = HEAD_PTR + 0x100000; // 1 MiB
const PREV_PTR: usize = HEAD4_PTR + 0x100000; // 1 MiB
const PREV4_PTR: usize = PREV_PTR + 0x40000; // 256 KiB
const COST_PTR: usize = PREV4_PTR + 0x40000; // 256 KiB
const CLEN_PTR: usize = COST_PTR + 0x190000; // ~1.6 MiB f64
const CDIST_PTR: usize = CLEN_PTR + 0x64000; // ~0.4 MiB i16
const CAND_PTR: usize = CDIST_PTR + 0xC8000; // ~0.8 MiB i32
const CCNT_PTR: usize = CAND_PTR + 0xC80000; // 12.5 MiB i32 packed cands
const TOKA_PTR: usize = CCNT_PTR + 0x31000; // ~0.2 MiB u8
const TOKB_PTR: usize = TOKA_PTR + 0xC8000; // 0.8 MiB i32
const BTOKA_PTR: usize = TOKB_PTR + 0xC8000; // 0.8 MiB i32
const BTOKB_PTR: usize = BTOKA_PTR + 0xC8000; // 0.8 MiB i32
const FREQ_PTR: usize = BTOKB_PTR + 0xC8000; // 0.8 MiB i32
const BFREQ_PTR: usize = FREQ_PTR + 0x500; // lit 288 + dist 32 i32
const LENS_PTR: usize = BFREQ_PTR + 0x500;
const CTAB_PTR: usize = LENS_PTR + 0x1000;
const HEAP_PTR: usize = CTAB_PTR + 0x50000; // ~0.32 MiB f64 cost tables
const CLSYMS_PTR: usize = HEAP_PTR + 0x6000;
const END_PTR: usize = CLSYMS_PTR + 0x4000;

// --- DEFLATE tables (filled once by initTables)
const LEN_BASE: i32[] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA: i32[] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE: i32[] = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA: i32[] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER: i32[] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Precomputed per-length code info: LEN_CODE[len] = code, LEN_EB[len] = extra bits,
// LEN_BASEV[len] = base length (extra value = len - base). Same for distances.
const LEN_CODE: i32[] = new Array<i32>(259);
const LEN_EB: i32[] = new Array<i32>(259);
const LEN_BASEV: i32[] = new Array<i32>(259);
const DIST_CODE: i32[] = new Array<i32>(WINDOW + 1);
const DIST_EB: i32[] = new Array<i32>(WINDOW + 1);
const DIST_BASEV: i32[] = new Array<i32>(WINDOW + 1);
const FIXED_LIT: i32[] = new Array<i32>(288);
const FIXED_DIST: i32[] = new Array<i32>(32);
let tablesReady: bool = false;

function initTables(): void {
  if (tablesReady) return;
  for (let len = MIN_MATCH; len <= MAX_MATCH; len++) {
    let c = 0;
    while (c < 28 && len >= LEN_BASE[c + 1]) c++;
    if (len === 258 && c === 28) {
      LEN_CODE[len] = 285; LEN_EB[len] = 0; LEN_BASEV[len] = 258;
    } else {
      LEN_CODE[len] = 257 + c; LEN_EB[len] = LEN_EXTRA[c]; LEN_BASEV[len] = LEN_BASE[c];
    }
  }
  for (let dist = 1; dist <= WINDOW; dist++) {
    let c = 0;
    while (c < 29 && dist >= DIST_BASE[c + 1]) c++;
    DIST_CODE[dist] = c; DIST_EB[dist] = DIST_EXTRA[c]; DIST_BASEV[dist] = DIST_BASE[c];
  }
  for (let i = 0; i < 288; i++) FIXED_LIT[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
  for (let i = 0; i < 32; i++) FIXED_DIST[i] = 5;
  // Mirror the fixed lengths into the raw LENS slots the driver uses.
  for (let i = 0; i < 288; i++) store<u8>(LL_FLIT + i, FIXED_LIT[i]);
  for (let i = 0; i < 32; i++) store<u8>(LL_FDIST + i, FIXED_DIST[i]);
  tablesReady = true;
}

// --- bit writer state (globals; one zlib stream per deflateAll call)
let bwPos: i32 = 0; // bytes written to OUT_PTR
let bwBit: i32 = 0; // bits used in the current partial byte
let bwAcc: i32 = 0; // accumulator (low bits hold the pending bits)

function bwWrite(value: i32, nbits: i32): void {
  bwAcc |= value << bwBit;
  bwBit += nbits;
  while (bwBit >= 8) {
    store<u8>(OUT_PTR + bwPos, bwAcc & 0xff);
    bwPos++;
    bwAcc >>>= 8;
    bwBit -= 8;
  }
}

function bwFinish(): i32 {
  if (bwBit > 0) {
    store<u8>(OUT_PTR + bwPos, bwAcc & 0xff);
    bwPos++;
    bwAcc = 0;
    bwBit = 0;
  }
  return bwPos;
}

/** Adler-32 of the input (standard, NMAX chunking — identical result to png.mjs).
 * NB: the accumulators MUST be i64 — with i32, `b` overflows inside one
 * 5552-byte chunk (it can reach ~8.2e9) and the checksum comes out wrong on
 * byte-rich inputs (i003/i004/i006/i007 failed round-trip on exactly this). */
function adler32(ptr: usize, len: i32): i32 {
  let a: i64 = 1;
  let b: i64 = 0;
  let i = 0;
  while (i < len) {
    const chunk = min(5552, len - i);
    const end = i + chunk;
    while (i < end) {
      a += load<u8>(ptr + i);
      b += a;
      i++;
    }
    a %= 65521;
    b %= 65521;
  }
  return <i32>(((b << 16) | a) & 0xffffffff);
}

/** Reverse `nbits` bits (DEFLATE writes Huffman codes MSB-first into an LSB-first stream). */
function reverseBits(code: i32, nbits: i32): i32 {
  let r = 0;
  for (let i = 0; i < nbits; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

// --- length-array slots inside LENS_PTR (all u8) ---
const LL_LIT: usize = LENS_PTR; // 288 refined lit lengths (current pass)
const LL_DIST: usize = LENS_PTR + 288; // 32 refined dist lengths
const LL_CLIT: usize = LENS_PTR + 320; // 288 cost-model lit lengths
const LL_CDIST: usize = LENS_PTR + 608; // 32 cost-model dist lengths
const LL_BLIT: usize = LENS_PTR + 640; // 288 best lit lengths
const LL_BDIST: usize = LENS_PTR + 928; // 32 best dist lengths
const LL_TMP: usize = LENS_PTR + 960; // 288 temp lit lengths
const LL_TMPD: usize = LENS_PTR + 1248; // 32 temp dist lengths

// --- Huffman heap scratch inside HEAP_PTR (all i32 unless noted) ---
const HP_W: usize = HEAP_PTR; // node weight
const HP_SYM: usize = HEAP_PTR + 2304; // node symbol (-1 = internal)
const HP_LEFT: usize = HEAP_PTR + 4608; // node left child
const HP_RIGHT: usize = HEAP_PTR + 6912; // node right child
const HP_TIE: usize = HEAP_PTR + 9216; // tie-break value (leaf sym, else left-leaf sym or 0)
const HP_IDX: usize = HEAP_PTR + 11520; // heap array of node indices
const HP_DEPTH: usize = HEAP_PTR + 13824; // leaf depths by symbol
const HP_STACK: usize = HEAP_PTR + 14976; // explicit stack (node, depth) pairs
const HP_ORDER: usize = HEAP_PTR + 19584; // sorted symbols (overflow path)
const HP_SYMS: usize = HEAP_PTR + 20736; // collected symbols
const HP_CCBL: usize = HEAP_PTR + 21888; // canonical blCount
const HP_CCNX: usize = HEAP_PTR + 22016; // canonical nextCode

// --- code-length RLE scratch inside CLSYMS_PTR ---
// entries are (sym, extra, extraBits) triples, i32 each; then clFreq, clCodes.
const CL_SYM: usize = CLSYMS_PTR; // triples, up to 1024 entries
const CL_FREQ: usize = CLSYMS_PTR + 0x3000; // 19 i32
const CL_CODE: usize = CLSYMS_PTR + 0x3100; // 19 i32 canonical cl codes
const CL_TMP: usize = CLSYMS_PTR + 0x3200; // 19 u8 cl lengths temp
const PARETO_D: usize = CLSYMS_PTR + 0x3800; // 256 i32 Pareto candidate distances
const PARETO_L: usize = CLSYMS_PTR + 0x3c00; // 256 i32 Pareto candidate lengths
let CL_HLIT: i32 = 0;
let CL_HDIST: i32 = 0;
let CL_NSYM: i32 = 0;
let clWip: i32 = 0; // working symbol count while encoding code lengths

function putSym(s: i32, e: i32, eb: i32): void {
  store<i32>(CL_SYM + (clWip * 12), s);
  store<i32>(CL_SYM + (clWip * 12) + 4, e);
  store<i32>(CL_SYM + (clWip * 12) + 8, eb);
  clWip++;
}

function hpCmp(a: i32, b: i32): i32 {
  const wa = load<i32>(HP_W + (a << 2));
  const wb = load<i32>(HP_W + (b << 2));
  if (wa != wb) return wa - wb;
  return load<i32>(HP_TIE + (a << 2)) - load<i32>(HP_TIE + (b << 2));
}

function hpSwap(i: i32, j: i32): void {
  const t = load<i32>(HP_IDX + (i << 2));
  store<i32>(HP_IDX + (i << 2), load<i32>(HP_IDX + (j << 2)));
  store<i32>(HP_IDX + (j << 2), t);
}

function hpSiftUp(pos: i32): void {
  while (pos > 0) {
    const p = (pos - 1) >> 1;
    if (hpCmp(load<i32>(HP_IDX + (p << 2)), load<i32>(HP_IDX + (pos << 2))) <= 0) break;
    hpSwap(p, pos);
    pos = p;
  }
}

function hpSiftDown(pos: i32, len: i32): void {
  for (;;) {
    const l = pos * 2 + 1;
    const r = l + 1;
    let m = pos;
    if (l < len && hpCmp(load<i32>(HP_IDX + (l << 2)), load<i32>(HP_IDX + (m << 2))) < 0) m = l;
    if (r < len && hpCmp(load<i32>(HP_IDX + (r << 2)), load<i32>(HP_IDX + (m << 2))) < 0) m = r;
    if (m == pos) break;
    hpSwap(m, pos);
    pos = m;
  }
}

/**
 * Length-limited Huffman code lengths from frequencies — same algorithm as
 * deflate.mjs huffmanLengths (plain Huffman tree; on overflow a greedy
 * length-limited construction with Kraft sum exactly 1). Writes u8 lengths
 * to outPtr (n entries). Deterministic: identical heap ops and tie-breaks.
 */
function huffLengths(freqPtr: usize, n: i32, maxLen: i32, outPtr: usize): void {
  memory.fill(outPtr, 0, n);
  let nsyms = 0;
  for (let i = 0; i < n; i++) {
    if (load<i32>(freqPtr + (i << 2)) > 0) {
      store<i32>(HP_SYMS + (nsyms << 2), i);
      nsyms++;
    }
  }
  if (nsyms == 0) return;
  if (nsyms == 1) {
    store<u8>(outPtr + load<i32>(HP_SYMS), 1);
    return;
  }
  // Leaf nodes 0..nsyms-1.
  for (let i = 0; i < nsyms; i++) {
    const s = load<i32>(HP_SYMS + (i << 2));
    store<i32>(HP_W + (i << 2), load<i32>(freqPtr + (s << 2)));
    store<i32>(HP_SYM + (i << 2), s);
    store<i32>(HP_LEFT + (i << 2), -1);
    store<i32>(HP_RIGHT + (i << 2), -1);
    store<i32>(HP_TIE + (i << 2), s);
    store<i32>(HP_IDX + (i << 2), i);
  }
  // Heapify.
  let heapLen = nsyms;
  for (let i = (heapLen >> 1) - 1; i >= 0; i--) hpSiftDown(i, heapLen);
  let nodeCount = nsyms;
  while (heapLen > 1) {
    // pop a
    const a = load<i32>(HP_IDX);
    const lastA = load<i32>(HP_IDX + ((heapLen - 1) << 2));
    heapLen--;
    if (heapLen > 0) {
      store<i32>(HP_IDX, lastA);
      hpSiftDown(0, heapLen);
    }
    // pop b
    const b = load<i32>(HP_IDX);
    const lastB = load<i32>(HP_IDX + ((heapLen - 1) << 2));
    heapLen--;
    if (heapLen > 0) {
      store<i32>(HP_IDX, lastB);
      hpSiftDown(0, heapLen);
    }
    // merge into a new internal node
    const ni = nodeCount++;
    store<i32>(HP_W + (ni << 2), load<i32>(HP_W + (a << 2)) + load<i32>(HP_W + (b << 2)));
    store<i32>(HP_SYM + (ni << 2), -1);
    store<i32>(HP_LEFT + (ni << 2), a);
    store<i32>(HP_RIGHT + (ni << 2), b);
    const leftSym = load<i32>(HP_SYM + (a << 2));
    store<i32>(HP_TIE + (ni << 2), leftSym >= 0 ? leftSym : 0);
    store<i32>(HP_IDX + (heapLen << 2), ni);
    heapLen++;
    hpSiftUp(heapLen - 1);
  }
  const root = load<i32>(HP_IDX);
  // Leaf depths by explicit stack (node, depth) pairs.
  for (let i = 0; i < n; i++) store<i32>(HP_DEPTH + (i << 2), -1);
  let sp = 0;
  store<i32>(HP_STACK + (sp << 3), root);
  store<i32>(HP_STACK + (sp << 3) + 4, 0);
  sp++;
  let maxDepth = 0;
  while (sp > 0) {
    sp--;
    const node = load<i32>(HP_STACK + (sp << 3));
    const d = load<i32>(HP_STACK + (sp << 3) + 4);
    const sym = load<i32>(HP_SYM + (node << 2));
    if (sym >= 0) {
      store<i32>(HP_DEPTH + (sym << 2), d);
      if (d > maxDepth) maxDepth = d;
    } else {
      store<i32>(HP_STACK + (sp << 3), load<i32>(HP_LEFT + (node << 2)));
      store<i32>(HP_STACK + (sp << 3) + 4, d + 1);
      sp++;
      store<i32>(HP_STACK + (sp << 3), load<i32>(HP_RIGHT + (node << 2)));
      store<i32>(HP_STACK + (sp << 3) + 4, d + 1);
      sp++;
    }
  }
  if (maxDepth <= maxLen) {
    for (let i = 0; i < nsyms; i++) {
      const s = load<i32>(HP_SYMS + (i << 2));
      store<u8>(outPtr + s, load<i32>(HP_DEPTH + (s << 2)));
    }
    return;
  }
  // Overflow: greedy length-limited construction.
  // order = syms sorted by (freq desc, sym asc) — insertion sort (total order).
  for (let i = 0; i < nsyms; i++) store<i32>(HP_ORDER + (i << 2), load<i32>(HP_SYMS + (i << 2)));
  for (let i = 1; i < nsyms; i++) {
    const v = load<i32>(HP_ORDER + (i << 2));
    const fv = load<i32>(freqPtr + (v << 2));
    let j = i - 1;
    while (j >= 0) {
      const u = load<i32>(HP_ORDER + (j << 2));
      const fu = load<i32>(freqPtr + (u << 2));
      if (fu > fv || (fu == fv && u < v)) break;
      store<i32>(HP_ORDER + ((j + 1) << 2), u);
      j--;
    }
    store<i32>(HP_ORDER + ((j + 1) << 2), v);
  }
  for (let i = 0; i < nsyms; i++) store<u8>(outPtr + load<i32>(HP_SYMS + (i << 2)), maxLen);
  let gap = (1 << maxLen) - nsyms;
  let r = 0;
  while (gap > 0) {
    const unit = 1 << r;
    const roundAdd = nsyms * unit;
    if (gap >= roundAdd) {
      for (let i = 0; i < nsyms; i++) {
        const s = load<i32>(HP_SYMS + (i << 2));
        store<u8>(outPtr + s, load<u8>(outPtr + s) - 1);
      }
      gap -= roundAdd;
    } else {
      const k = gap / unit;
      for (let i = 0; i < k; i++) {
        const s = load<i32>(HP_ORDER + (i << 2));
        store<u8>(outPtr + s, load<u8>(outPtr + s) - 1);
      }
      gap = 0;
    }
    r++;
  }
}

/** Canonical Huffman codes from lengths: codesPtr gets MSB-first values (i32). */
function canonicalCodes(lenPtr: usize, n: i32, codesPtr: usize): void {
  let maxLen = 0;
  for (let i = 0; i < n; i++) {
    const l: i32 = load<u8>(lenPtr + i);
    if (l > maxLen) maxLen = l;
  }
  memory.fill(HP_CCBL, 0, (maxLen + 1) << 2);
  for (let i = 0; i < n; i++) {
    const l: i32 = load<u8>(lenPtr + i);
    if (l > 0) store<i32>(HP_CCBL + (l << 2), load<i32>(HP_CCBL + (l << 2)) + 1);
  }
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + load<i32>(HP_CCBL + ((bits - 1) << 2))) << 1;
    store<i32>(HP_CCNX + (bits << 2), code);
  }
  for (let i = 0; i < n; i++) {
    const len: i32 = load<u8>(lenPtr + i);
    if (len > 0) {
      const c = load<i32>(HP_CCNX + (len << 2));
      store<i32>(codesPtr + (i << 2), c);
      store<i32>(HP_CCNX + (len << 2), c + 1);
    } else {
      store<i32>(codesPtr + (i << 2), 0);
    }
  }
}

/** A single-code alphabet is incomplete; give a second unused symbol length 1. */
function ensureTwoCodes(lenPtr: usize, n: i32): void {
  let count = 0;
  for (let i = 0; i < n; i++) if (load<u8>(lenPtr + i) > 0) count++;
  if (count == 1) {
    for (let i = 0; i < n; i++) {
      if (load<u8>(lenPtr + i) == 0) {
        store<u8>(lenPtr + i, 1);
        break;
      }
    }
  }
}

// --- code-length RLE + dynamic header ---
// Reads the lit/dist lengths, writes the RLE symbols as (sym, extra, extraBits)
// triples to CL_SYM, the code-length code lengths to CL_TMP, and sets the
// CL_HLIT / CL_HDIST / CL_NSYM globals.
function encodeCodeLengths(litLenPtr: usize, distLenPtr: usize): void {
  let hlit = 288;
  let hdist = 32;
  while (hlit > 257 && load<u8>(litLenPtr + hlit - 1) == 0) hlit--;
  while (hdist > 1 && load<u8>(distLenPtr + hdist - 1) == 0) hdist--;
  CL_HLIT = hlit;
  CL_HDIST = hdist;
  const total = hlit + hdist;
  clWip = 0;
  let i = 0;
  while (i < total) {
    const v = i < hlit ? load<u8>(litLenPtr + i) : load<u8>(distLenPtr + i - hlit);
    if (v == 0) {
      let run = 0;
      while (i + run < total) {
        const vv = i + run < hlit ? load<u8>(litLenPtr + i + run) : load<u8>(distLenPtr + i + run - hlit);
        if (vv != 0) break;
        run++;
      }
      while (run >= 11) {
        const take = min(run, 138);
        putSym(18, take - 11, 7);
        i += take;
        run -= take;
      }
      if (run >= 3) {
        putSym(17, run - 3, 3);
        i += run;
      } else {
        for (let k = 0; k < run; k++) putSym(0, 0, 0);
        i += run;
      }
    } else {
      putSym(v, 0, 0);
      i++;
      let run = 0;
      while (i + run < total) {
        const vv = i + run < hlit ? load<u8>(litLenPtr + i + run) : load<u8>(distLenPtr + i + run - hlit);
        if (vv != v) break;
        run++;
      }
      while (run >= 3) {
        const take = min(run, 6);
        putSym(16, take - 3, 2);
        i += take;
        run -= take;
      }
      for (let k = 0; k < run; k++) {
        putSym(v, 0, 0);
        i++;
      }
    }
  }
  CL_NSYM = clWip;
  memory.fill(CL_FREQ, 0, 19 << 2);
  for (let k = 0; k < clWip; k++) {
    const s = load<i32>(CL_SYM + (k * 12));
    store<i32>(CL_FREQ + (s << 2), load<i32>(CL_FREQ + (s << 2)) + 1);
  }
  huffLengths(CL_FREQ, 19, 7, CL_TMP);
  ensureTwoCodes(CL_TMP, 19);
}

/** Write a dynamic Huffman block header (HLIT/HDIST/HCLEN + code lengths). */
function writeDynamicHeader(litLenPtr: usize, distLenPtr: usize): void {
  encodeCodeLengths(litLenPtr, distLenPtr);
  canonicalCodes(CL_TMP, 19, CL_CODE);
  let hclen = 19;
  while (hclen > 4 && load<u8>(CL_TMP + CL_ORDER[hclen - 1]) == 0) hclen--;
  bwWrite(CL_HLIT - 257, 5);
  bwWrite(CL_HDIST - 1, 5);
  bwWrite(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bwWrite(load<u8>(CL_TMP + CL_ORDER[k]), 3);
  for (let k = 0; k < CL_NSYM; k++) {
    const s = load<i32>(CL_SYM + (k * 12));
    const extra = load<i32>(CL_SYM + (k * 12) + 4);
    const extraBits = load<i32>(CL_SYM + (k * 12) + 8);
    bwWrite(reverseBits(load<i32>(CL_CODE + (s << 2)), load<u8>(CL_TMP + s)), load<u8>(CL_TMP + s));
    if (extraBits > 0) bwWrite(extra, extraBits);
  }
}

// --- LZ77 match finding ---
// Global encoder state (per deflateAll call): head/prev chains live in the
// fixed regions; insertedUpTo tracks how far positions have been inserted.
let encInserted: i32 = 0;

function hash3At(ptr: usize, i: i32): i32 {
  // NB: the <i32> casts are REQUIRED — AssemblyScript evaluates a shift on a
  // u8 in u8 arithmetic (shift count masked to 3 bits, result truncated),
  // which would collapse the hash to 8 bits. Cast first, shift in i32.
  return ((<i32>load<u8>(ptr + i) << 10) ^ (<i32>load<u8>(ptr + i + 1) << 5) ^ <i32>load<u8>(ptr + i + 2)) & HASH_MASK;
}

function hash4At(ptr: usize, i: i32): i32 {
  return ((<i32>load<u8>(ptr + i) << 15) ^ (<i32>load<u8>(ptr + i + 1) << 10) ^ (<i32>load<u8>(ptr + i + 2) << 5) ^ <i32>load<u8>(ptr + i + 3)) & HASH_MASK;
}

/** Match length of data[j..] vs data[i..], capped at `cap`. */
function matchLenAt(ptr: usize, n: i32, i: i32, j: i32, cap: i32): i32 {
  let k = 0;
  const lim = min(cap, min(n - i, n - j));
  while (k < lim && load<u8>(ptr + i + k) == load<u8>(ptr + j + k)) k++;
  return k;
}

function insertPos(ptr: usize, n: i32, i: i32): void {
  if (i + 2 < n) {
    const h = hash3At(ptr, i);
    store<i32>(PREV_PTR + ((i & PREV_MASK) << 2), load<i32>(HEAD_PTR + (h << 2)));
    store<i32>(HEAD_PTR + (h << 2), i);
    if (i + 3 < n) {
      const h4 = hash4At(ptr, i);
      store<i32>(PREV4_PTR + ((i & PREV_MASK) << 2), load<i32>(HEAD4_PTR + (h4 << 2)));
      store<i32>(HEAD4_PTR + (h4 << 2), i);
    }
  }
}

function insertRange(ptr: usize, n: i32, from: i32, to: i32): void {
  for (let i = from; i < to; i++) {
    if (i + 2 >= n) break;
    insertPos(ptr, n, i);
  }
  if (to > encInserted) encInserted = to;
}

/**
 * Find match candidates for every position in [bs, be): up to maxCand
 * (len, dist) pairs with distinct distances, packed into CAND_PTR as
 * (len<<16 | dist) with stride CAND_CAP, counts in CCNT_PTR.
 * Inserts positions as it goes (chains persist across blocks).
 *
 * NOTE on the circular prev buffers: a prev link is only ever read while its
 * position is within the 32 KiB window of the current position, and its slot
 * is only overwritten by a position 65536 newer — i.e. past the current
 * position — so no live link is ever clobbered. The byte-compare test
 * against the JS reference proves this on all 8 instances.
 */
function findCandidates(ptr: usize, n: i32, bs: i32, be: i32, chain4Limit: i32, chain3Limit: i32, maxCand: i32): void {
  const nb = be - bs;
  if (encInserted < bs) insertRange(ptr, n, encInserted, bs);
  for (let i = bs; i < be; i++) {
    const p = i - bs;
    if (i + 2 < n && be - i >= MIN_MATCH) {
      const cap = min(MAX_MATCH, be - i);
      let best = 0;
      // Pareto scratch: strictly increasing lengths, so at most 256 entries
      // (lengths 3..258). Dedicated region — NOT the heap stack (that was a
      // 64-entry scratch and overflowed into the lens array on i001).
      const distsPtr = PARETO_D;
      const lensPtr = PARETO_L;
      let pcnt = 0;
      // Walk 1: the 4-byte hash chain — long matches.
      if (i + 3 < n) {
        const h4 = hash4At(ptr, i);
        let j = load<i32>(HEAD4_PTR + (h4 << 2));
        let steps = 0;
        while (j >= 0 && steps < chain4Limit) {
          const dist = i - j;
          if (dist > WINDOW) break;
          let len = 0;
          if (best == 0) {
            if (load<u8>(ptr + j) == load<u8>(ptr + i) && load<u8>(ptr + j + 1) == load<u8>(ptr + i + 1) && load<u8>(ptr + j + 2) == load<u8>(ptr + i + 2) && load<u8>(ptr + j + 3) == load<u8>(ptr + i + 3)) {
              len = matchLenAt(ptr, n, i, j, cap);
            }
          } else if (best < cap && load<u8>(ptr + j + best) == load<u8>(ptr + i + best)) {
            len = matchLenAt(ptr, n, i, j, cap);
          }
          if (len >= MIN_MATCH && len > best) {
            best = len;
            store<i32>(distsPtr + (pcnt << 2), dist);
            store<i32>(lensPtr + (pcnt << 2), len);
            pcnt++;
            if (best >= 128) break;
          }
          j = load<i32>(PREV4_PTR + ((j & PREV_MASK) << 2));
          steps++;
        }
      }
      // Walk 2: the 3-byte hash chain — the exactly-3-byte matches the
      // 4-byte walk cannot see, plus near short matches.
      {
        const h = hash3At(ptr, i);
        let j = load<i32>(HEAD_PTR + (h << 2));
        let steps = 0;
        while (j >= 0 && steps < chain3Limit) {
          const dist = i - j;
          if (dist > WINDOW) break;
          let len = 0;
          if (best == 0) {
            if (load<u8>(ptr + j) == load<u8>(ptr + i) && load<u8>(ptr + j + 1) == load<u8>(ptr + i + 1) && load<u8>(ptr + j + 2) == load<u8>(ptr + i + 2)) {
              len = matchLenAt(ptr, n, i, j, cap);
            }
          } else if (best < cap && load<u8>(ptr + j + best) == load<u8>(ptr + i + best)) {
            len = matchLenAt(ptr, n, i, j, cap);
          }
          if (len >= MIN_MATCH && len > best) {
            best = len;
            store<i32>(distsPtr + (pcnt << 2), dist);
            store<i32>(lensPtr + (pcnt << 2), len);
            pcnt++;
            if (best >= 128) break;
          }
          j = load<i32>(PREV_PTR + ((j & PREV_MASK) << 2));
          steps++;
        }
      }
      // Store candidates: the first (nearest) plus the longest ones.
      let cnt = 0;
      if (pcnt > 0) {
        store<i32>(CAND_PTR + ((p * CAND_CAP + cnt) << 2), (load<i32>(lensPtr) << 16) | load<i32>(distsPtr));
        cnt++;
        for (let k = pcnt - 1; k >= 1 && cnt < maxCand; k--) {
          store<i32>(CAND_PTR + ((p * CAND_CAP + cnt) << 2), (load<i32>(lensPtr + (k << 2)) << 16) | load<i32>(distsPtr + (k << 2)));
          cnt++;
        }
      }
      store<u8>(CCNT_PTR + p, cnt);
    } else {
      store<u8>(CCNT_PTR + p, 0);
    }
    // Insert this position for later positions.
    insertPos(ptr, n, i);
  }
  if (be > encInserted) encInserted = be;
}

// --- cost tables + optimal parse ---
const CT_LIT: usize = CTAB_PTR; // f64[286]
const CT_LEN: usize = CTAB_PTR + 2288; // f64[259]
const CT_DIST: usize = CTAB_PTR + 4360; // f64[32769]
const LFREQ: usize = FREQ_PTR; // i32[288]
const DFREQ: usize = FREQ_PTR + 1152; // i32[32]
const BLFREQ: usize = BFREQ_PTR; // i32[288] best lit freq
const BDFREQ: usize = BFREQ_PTR + 1152; // i32[32] best dist freq
const LL_FLIT: usize = LENS_PTR + 1280; // 288 fixed lit lengths (u8)
const LL_FDIST: usize = LENS_PTR + 1568; // 32 fixed dist lengths (u8)
const LCODES: usize = CLSYMS_PTR + 0x3300; // i32[288] canonical lit codes
const DCODES: usize = CLSYMS_PTR + 0x3780; // i32[32] canonical dist codes
const LADDER: i32[] = [12, 16, 24, 32, 48, 64, 96, 128];

let tokCount: i32 = 0; // tokens in TOKA/TOKB for the current pass
let bestTokCount: i32 = 0; // tokens in BTOKA/BTOKB for the best pass

function buildCostTables(litLenPtr: usize, distLenPtr: usize): void {
  for (let i = 0; i < 286; i++) store<f64>(CT_LIT + (i << 3), load<u8>(litLenPtr + i));
  for (let len = MIN_MATCH; len <= MAX_MATCH; len++) {
    store<f64>(CT_LEN + (len << 3), load<u8>(litLenPtr + LEN_CODE[len]) + LEN_EB[len]);
  }
  for (let dist = 1; dist <= WINDOW; dist++) {
    store<f64>(CT_DIST + (dist << 3), load<u8>(distLenPtr + DIST_CODE[dist]) + DIST_EB[dist]);
  }
}

/** Cost-model lengths: unused symbols keep the fixed length (never free). */
function mergeLengths(refPtr: usize, fixPtr: usize, outPtr: usize, n: i32): void {
  for (let i = 0; i < n; i++) {
    const r = load<u8>(refPtr + i);
    store<u8>(outPtr + i, r > 0 ? r : load<u8>(fixPtr + i));
  }
}

/**
 * Dynamic-programming optimal parse of one block. Fills TOKA/TOKB (tokens in
 * forward order), LFREQ/DFREQ, and returns the DP bit cost (cost[n]).
 */
function optimalParse(bs: i32, be: i32, litLenPtr: usize, distLenPtr: usize): f64 {
  const n = be - bs;
  buildCostTables(litLenPtr, distLenPtr);
  for (let i = 0; i <= n; i++) store<f64>(COST_PTR + (i << 3), Infinity);
  store<f64>(COST_PTR, 0);
  for (let i = 0; i < n; i++) {
    const c = load<f64>(COST_PTR + (i << 3));
    if (c == Infinity) continue;
    // Literal. (NB: cast the loaded byte to i32 BEFORE shifting — a u8
    // shift in AssemblyScript wraps at 8 bits and would read the wrong cost.)
    const lc = c + load<f64>(CT_LIT + (<i32>load<u8>(IN_PTR + bs + i) << 3));
    if (lc < load<f64>(COST_PTR + ((i + 1) << 3))) {
      store<f64>(COST_PTR + ((i + 1) << 3), lc);
      store<i16>(CLEN_PTR + ((i + 1) << 1), 0);
      store<i32>(CDIST_PTR + ((i + 1) << 2), 0);
    }
    // Matches: for each candidate, a reduced set of lengths.
    const cnt: i32 = load<u8>(CCNT_PTR + i);
    for (let k = 0; k < cnt; k++) {
      const packed = load<i32>(CAND_PTR + ((i * CAND_CAP + k) << 2));
      const L = packed >> 16;
      const D = packed & 0xffff;
      const dc = load<f64>(CT_DIST + (D << 3));
      for (let len = MIN_MATCH; len <= 8 && len <= L; len++) {
        const nc = c + load<f64>(CT_LEN + (len << 3)) + dc;
        if (nc < load<f64>(COST_PTR + ((i + len) << 3))) {
          store<f64>(COST_PTR + ((i + len) << 3), nc);
          store<i16>(CLEN_PTR + ((i + len) << 1), len);
          store<i32>(CDIST_PTR + ((i + len) << 2), D);
        }
      }
      for (let q = 0; q < 8; q++) {
        const len = LADDER[q];
        if (len > L) break;
        const nc = c + load<f64>(CT_LEN + (len << 3)) + dc;
        if (nc < load<f64>(COST_PTR + ((i + len) << 3))) {
          store<f64>(COST_PTR + ((i + len) << 3), nc);
          store<i16>(CLEN_PTR + ((i + len) << 1), len);
          store<i32>(CDIST_PTR + ((i + len) << 2), D);
        }
      }
      for (let len = max(9, L - 7); len <= L; len++) {
        if (len == 12 || len == 16 || len == 24 || len == 32 || len == 48 || len == 64 || len == 96 || len == 128) continue;
        const nc = c + load<f64>(CT_LEN + (len << 3)) + dc;
        if (nc < load<f64>(COST_PTR + ((i + len) << 3))) {
          store<f64>(COST_PTR + ((i + len) << 3), nc);
          store<i16>(CLEN_PTR + ((i + len) << 1), len);
          store<i32>(CDIST_PTR + ((i + len) << 2), D);
        }
      }
    }
  }
  // Walk back to tokens (appended in reverse, then reversed in place).
  memory.fill(LFREQ, 0, 288 << 2);
  memory.fill(DFREQ, 0, 32 << 2);
  tokCount = 0;
  let i = n;
  while (i > 0) {
    const len: i32 = load<i16>(CLEN_PTR + (i << 1));
    if (len == 0) {
      const sym: i32 = load<u8>(IN_PTR + bs + i - 1);
      store<i32>(TOKA_PTR + (tokCount << 2), sym);
      store<i32>(TOKB_PTR + (tokCount << 2), 0);
      tokCount++;
      store<i32>(LFREQ + (sym << 2), load<i32>(LFREQ + (sym << 2)) + 1);
      i--;
    } else {
      const dist = load<i32>(CDIST_PTR + (i << 2));
      store<i32>(TOKA_PTR + (tokCount << 2), len);
      store<i32>(TOKB_PTR + (tokCount << 2), dist);
      tokCount++;
      const lc = LEN_CODE[len];
      const dc = DIST_CODE[dist];
      store<i32>(LFREQ + (lc << 2), load<i32>(LFREQ + (lc << 2)) + 1);
      store<i32>(DFREQ + (dc << 2), load<i32>(DFREQ + (dc << 2)) + 1);
      i -= len;
    }
  }
  // Reverse tokens in place (TOKA/TOKB).
  for (let a = 0, b = tokCount - 1; a < b; a++, b--) {
    const ta = load<i32>(TOKA_PTR + (a << 2));
    const tb = load<i32>(TOKB_PTR + (a << 2));
    store<i32>(TOKA_PTR + (a << 2), load<i32>(TOKA_PTR + (b << 2)));
    store<i32>(TOKB_PTR + (a << 2), load<i32>(TOKB_PTR + (b << 2)));
    store<i32>(TOKA_PTR + (b << 2), ta);
    store<i32>(TOKB_PTR + (b << 2), tb);
  }
  store<i32>(LFREQ + (256 << 2), load<i32>(LFREQ + (256 << 2)) + 1); // end of block
  return load<f64>(COST_PTR + (n << 3));
}

/** Bits to emit tokens with the given lengths (dynamic block, header excluded). */
function tokensBitCost(tokAPtr: usize, tokBPtr: usize, count: i32, litLenPtr: usize, distLenPtr: usize): f64 {
  let bits: f64 = 0;
  for (let t = 0; t < count; t++) {
    const a = load<i32>(tokAPtr + (t << 2));
    const b = load<i32>(tokBPtr + (t << 2));
    if (b == 0) {
      bits += load<u8>(litLenPtr + a);
    } else {
      bits += load<u8>(litLenPtr + LEN_CODE[a]) + LEN_EB[a];
      bits += load<u8>(distLenPtr + DIST_CODE[b]) + DIST_EB[b];
    }
  }
  bits += load<u8>(litLenPtr + 256);
  return bits;
}

/** Emit tokens into the bit writer with the given lengths. */
function emitTokens(tokAPtr: usize, tokBPtr: usize, count: i32, litCodesPtr: usize, litLenPtr: usize, distCodesPtr: usize, distLenPtr: usize): void {
  for (let t = 0; t < count; t++) {
    const a = load<i32>(tokAPtr + (t << 2));
    const b = load<i32>(tokBPtr + (t << 2));
    if (b == 0) {
      const len = load<u8>(litLenPtr + a);
      bwWrite(reverseBits(load<i32>(litCodesPtr + (a << 2)), len), len);
    } else {
      const lc = LEN_CODE[a];
      const ll = load<u8>(litLenPtr + lc);
      bwWrite(reverseBits(load<i32>(litCodesPtr + (lc << 2)), ll), ll);
      if (LEN_EB[a] > 0) bwWrite(a - LEN_BASEV[a], LEN_EB[a]);
      const dc = DIST_CODE[b];
      const dl = load<u8>(distLenPtr + dc);
      bwWrite(reverseBits(load<i32>(distCodesPtr + (dc << 2)), dl), dl);
      if (DIST_EB[b] > 0) bwWrite(b - DIST_BASEV[b], DIST_EB[b]);
    }
  }
  const e = load<u8>(litLenPtr + 256);
  bwWrite(reverseBits(load<i32>(litCodesPtr + (256 << 2)), e), e);
}

// --- driver + exports ---
export function inputPtr(): usize {
  return IN_PTR;
}

export function outputPtr(): usize {
  return OUT_PTR;
}

export function layoutEnd(): usize {
  return END_PTR;
}

export function candPtr(): usize {
  return CAND_PTR;
}

export function ccntPtr(): usize {
  return CCNT_PTR;
}

export function tokPtrA(): usize {
  return TOKA_PTR;
}

export function tokPtrB(): usize {
  return TOKB_PTR;
}

export function freqPtr(): usize {
  return FREQ_PTR;
}

let dbgBitCost: f64 = 0;

export function dbgBitCostOut(): f64 {
  return dbgBitCost;
}

export function dbgTokCount(): i32 {
  return tokCount;
}

export function dbgHash3(i: i32): i32 {
  return hash3At(IN_PTR, i);
}

export function dbgHash4(i: i32): i32 {
  return hash4At(IN_PTR, i);
}

/** Debug: run huffLengths on freqs (i32) at freqPtr, write u8 lengths to outPtr. */
export function dbgHuff(freqPtr: usize, n: i32, maxLen: i32, outPtr: usize): void {
  huffLengths(freqPtr, n, maxLen, outPtr);
}

export function scratchPtr(): usize {
  return CLSYMS_PTR;
}

/** Debug: run findCandidates on [bs, be) with fresh chains; candidates land in CAND_PTR/CCNT_PTR. */
export function dbgFindCandidates(inLen: i32, bs: i32, be: i32, chain4Limit: i32, chain3Limit: i32, maxCand: i32): i32 {
  initTables();
  memory.fill(HEAD_PTR, 0xff, HASH_SIZE << 2);
  memory.fill(HEAD4_PTR, 0xff, HASH_SIZE << 2);
  encInserted = 0;
  findCandidates(IN_PTR, inLen, bs, be, chain4Limit, chain3Limit, maxCand);
  return 0;
}

/** Debug: one optimal-parse pass with fixed costs; tokens land in TOKA/TOKB, freqs in FREQ_PTR. */
export function dbgParse(inLen: i32, bs: i32, be: i32, chain4Limit: i32, chain3Limit: i32, maxCand: i32): i32 {
  initTables();
  memory.fill(HEAD_PTR, 0xff, HASH_SIZE << 2);
  memory.fill(HEAD4_PTR, 0xff, HASH_SIZE << 2);
  encInserted = 0;
  findCandidates(IN_PTR, inLen, bs, be, chain4Limit, chain3Limit, maxCand);
  dbgBitCost = optimalParse(bs, be, LL_FLIT, LL_FDIST);
  return tokCount;
}

/**
 * Deflate the filtered data already placed at IN_PTR (inLen bytes) into one
 * zlib stream at OUT_PTR. Returns the stream length, or -1 on bad parameters.
 * chain4Limit / chain3Limit / maxCand / dpPasses / blockSize are the search
 * configuration (v1.2 defaults: 1024 / 16 / 8 / 3 / 200000).
 */
export function deflateAll(inLen: i32, chain4Limit: i32, chain3Limit: i32, maxCand: i32, dpPasses: i32, blockSize: i32): i32 {
  initTables();
  if (inLen < 0 || inLen > IN_MAX) return -1;
  if (blockSize < 1 || blockSize > BLOCK_CAP) return -1;
  if (maxCand < 1 || maxCand > CAND_CAP) return -1;
  if (dpPasses < 1 || dpPasses > 8) return -1;
  // Reset chains and bit writer.
  memory.fill(HEAD_PTR, 0xff, HASH_SIZE << 2);
  memory.fill(HEAD4_PTR, 0xff, HASH_SIZE << 2);
  encInserted = 0;
  bwPos = 0;
  bwBit = 0;
  bwAcc = 0;
  bwWrite(0x78, 8); // zlib header, default compression, 32K window
  bwWrite(0x9c, 8);
  const n = inLen;
  for (let bs = 0; bs < n; bs += blockSize) {
    const be = min(n, bs + blockSize);
    const last = be >= n;
    findCandidates(IN_PTR, n, bs, be, chain4Limit, chain3Limit, maxCand);
    // DP passes: fixed costs first, then refined lengths. Keep the best
    // pass by its true cost under its own Huffman, not the last.
    let bestBits: f64 = Infinity;
    bestTokCount = 0;
    memory.copy(LL_CLIT, LL_FLIT, 288);
    memory.copy(LL_CDIST, LL_FDIST, 32);
    for (let pass = 0; pass < dpPasses; pass++) {
      optimalParse(bs, be, LL_CLIT, LL_CDIST);
      huffLengths(LFREQ, 288, 15, LL_TMP);
      huffLengths(DFREQ, 32, 15, LL_TMPD);
      // A dist alphabet with no matches needs one dummy code (never emitted).
      let hasDist = false;
      for (let s = 0; s < 32; s++) {
        if (load<i32>(DFREQ + (s << 2)) > 0) {
          hasDist = true;
          break;
        }
      }
      if (!hasDist) store<u8>(LL_TMPD, 1);
      const bits = tokensBitCost(TOKA_PTR, TOKB_PTR, tokCount, LL_TMP, LL_TMPD);
      if (bits < bestBits) {
        bestBits = bits;
        memory.copy(BTOKA_PTR, TOKA_PTR, tokCount << 2);
        memory.copy(BTOKB_PTR, TOKB_PTR, tokCount << 2);
        memory.copy(BLFREQ, LFREQ, 288 << 2);
        memory.copy(BDFREQ, DFREQ, 32 << 2);
        memory.copy(LL_BLIT, LL_TMP, 288);
        memory.copy(LL_BDIST, LL_TMPD, 32);
        bestTokCount = tokCount;
      }
      mergeLengths(LL_TMP, LL_FLIT, LL_CLIT, 288);
      mergeLengths(LL_TMPD, LL_FDIST, LL_CDIST, 32);
    }
    memory.copy(LL_LIT, LL_BLIT, 288);
    memory.copy(LL_DIST, LL_BDIST, 32);
    ensureTwoCodes(LL_LIT, 288);
    ensureTwoCodes(LL_DIST, 32);
    // Choose dynamic vs fixed Huffman for this block.
    const dynBits = bestBits;
    const fixBits = tokensBitCost(BTOKA_PTR, BTOKB_PTR, bestTokCount, LL_FLIT, LL_FDIST);
    let dynamicValid = true;
    for (let s = 0; s < 288; s++) {
      if (load<i32>(BLFREQ + (s << 2)) > 0 && load<u8>(LL_LIT + s) == 0) dynamicValid = false;
    }
    for (let s = 0; s < 32; s++) {
      if (load<i32>(BDFREQ + (s << 2)) > 0 && load<u8>(LL_DIST + s) == 0) dynamicValid = false;
    }
    const useDynamic = dynamicValid && dynBits + 400 < fixBits;
    bwWrite(last ? 1 : 0, 1);
    if (useDynamic) {
      bwWrite(2, 2);
      writeDynamicHeader(LL_LIT, LL_DIST);
      canonicalCodes(LL_LIT, 288, LCODES);
      canonicalCodes(LL_DIST, 32, DCODES);
      emitTokens(BTOKA_PTR, BTOKB_PTR, bestTokCount, LCODES, LL_LIT, DCODES, LL_DIST);
    } else {
      bwWrite(1, 2);
      canonicalCodes(LL_FLIT, 288, LCODES);
      canonicalCodes(LL_FDIST, 32, DCODES);
      emitTokens(BTOKA_PTR, BTOKB_PTR, bestTokCount, LCODES, LL_FLIT, DCODES, LL_FDIST);
    }
  }
  const body = bwFinish();
  const ad = adler32(IN_PTR, n);
  store<u8>(OUT_PTR + body, (ad >>> 24) & 0xff);
  store<u8>(OUT_PTR + body + 1, (ad >>> 16) & 0xff);
  store<u8>(OUT_PTR + body + 2, (ad >>> 8) & 0xff);
  store<u8>(OUT_PTR + body + 3, ad & 0xff);
  return body + 4;
}
