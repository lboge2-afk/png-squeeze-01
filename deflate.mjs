// png-squeeze-01 entry: optimal-parsing DEFLATE, written for this entry (Node 22, stdlib only).
// Hash-chain LZ77 + dynamic-programming optimal parse with iterated Huffman refinement,
// block splitting, dynamic Huffman with length-limited codes, RLE code-length code.
// Deterministic: fixed iteration counts, no clock, no randomness.

import { adler32 } from './png.mjs';

/** Length codes 257..285: base length and extra bits. */
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
/** Distance codes 0..29: base distance and extra bits. */
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** Code-length code symbol order. */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
/** Fixed Huffman lengths: literals 0..287, distances 0..31. */
const FIXED_LIT_LEN = new Uint8Array(288);
const FIXED_DIST_LEN = new Uint8Array(32);
for (let i = 0; i < 288; i++) FIXED_LIT_LEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
FIXED_DIST_LEN.fill(5);

/** Length code (257..285) and extra bits for a match length 3..258. */
export function lengthCode(len) {
  let c = 0;
  while (c < 28 && len >= LEN_BASE[c + 1]) c++;
  if (len === 258 && c === 28) return { code: 285, extra: 0, extraBits: 0 };
  return { code: 257 + c, extra: len - LEN_BASE[c], extraBits: LEN_EXTRA[c] };
}
/** Distance code (0..29) and extra bits for a distance 1..32768. */
export function distanceCode(dist) {
  let c = 0;
  while (c < 29 && dist >= DIST_BASE[c + 1]) c++;
  return { code: c, extra: dist - DIST_BASE[c], extraBits: DIST_EXTRA[c] };
}

/** Bit writer: bits go LSB-first into a byte array. */
export class BitWriter {
  constructor(capacity) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0; // bytes written
    this.bit = 0; // bits used in the current partial byte (0..7)
    this.acc = 0;
  }
  write(value, nbits) {
    this.acc |= value << this.bit;
    this.bit += nbits;
    while (this.bit >= 8) {
      this.buf[this.pos++] = this.acc & 0xff;
      this.acc >>>= 8;
      this.bit -= 8;
    }
  }
  /** Flush the partial byte (zero-padded) and return the bytes written so far. */
  finish() {
    if (this.bit > 0) {
      this.buf[this.pos++] = this.acc & 0xff;
      this.acc = 0;
      this.bit = 0;
    }
    return this.buf.subarray(0, this.pos);
  }
  get bits() { return this.pos * 8 + this.bit; }
}

/**
 * Length-limited Huffman code lengths. Built from a plain Huffman tree:
 * when no leaf is deeper than maxLen the tree depths are used directly
 * (optimal, Kraft sum 1). When the tree overflows, a greedy construction
 * takes over: every symbol starts at maxLen and the most frequent symbol
 * at the longest length is shortened until the Kraft sum is exactly 1.
 * That shortening never overshoots (the gap is always a multiple of the
 * step) and it terminates, so the code is always valid. Deterministic.
 */
export function huffmanLengths(freqs, maxLen) {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  const syms = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
  // Plain Huffman tree via a binary heap (leaves {sym, w}, internal {left, right, w}).
  const heap = syms.map((s) => ({ w: freqs[s], sym: s }));
  const cmp = (a, b) => a.w - b.w || ((a.sym ?? a.left.sym ?? 0) - (b.sym ?? b.left.sym ?? 0));
  const heapPush = (node) => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cmp(heap[p], heap[i]) <= 0) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && cmp(heap[l], heap[m]) < 0) m = l;
        if (r < heap.length && cmp(heap[r], heap[m]) < 0) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  // Heapify the initial leaves.
  for (let i = (heap.length >> 1) - 1; i >= 0; i--) {
    let j = i;
    for (;;) {
      const l = j * 2 + 1, r = l + 1;
      let m = j;
      if (l < heap.length && cmp(heap[l], heap[m]) < 0) m = l;
      if (r < heap.length && cmp(heap[r], heap[m]) < 0) m = r;
      if (m === j) break;
      [heap[m], heap[j]] = [heap[j], heap[m]];
      j = m;
    }
  }
  while (heap.length > 1) {
    const a = heapPop(), b = heapPop();
    heapPush({ w: a.w + b.w, left: a, right: b });
  }
  const root = heap[0];
  // Leaf depths by stack.
  const leafDepth = new Map();
  const stack = [[root, 0]];
  let maxDepth = 0;
  while (stack.length > 0) {
    const [node, d] = stack.pop();
    if (node.sym !== undefined) {
      leafDepth.set(node.sym, d);
      if (d > maxDepth) maxDepth = d;
    } else {
      stack.push([node.left, d + 1], [node.right, d + 1]);
    }
  }
  if (maxDepth <= maxLen) {
    for (const s of syms) lengths[s] = leafDepth.get(s);
    return lengths;
  }
  // Overflow: greedy length-limited construction (see above). The iterative
  // form shortens symbols round-robin by frequency, one level per round, so
  // it is computed directly per round instead of per symbol.
  const order = syms.slice().sort((a, b) => freqs[b] - freqs[a] || a - b);
  for (const s of syms) lengths[s] = maxLen;
  // Kraft sum in units of 2^-maxLen; each symbol contributes 1, target 2^maxLen.
  let gap = (1 << maxLen) - syms.length;
  let r = 0;
  while (gap > 0) {
    const unit = 1 << r;
    const roundAdd = syms.length * unit;
    if (gap >= roundAdd) {
      for (const s of syms) lengths[s]--;
      gap -= roundAdd;
    } else {
      const k = gap / unit; // exact: the remaining gap is a multiple of unit
      for (let i = 0; i < k; i++) lengths[order[i]]--;
      gap = 0;
    }
    r++;
  }
  return lengths;
}

/** Canonical Huffman codes from lengths: returns {codes, lengths} with codes MSB-first values. */
export function canonicalCodes(lengths) {
  const n = lengths.length;
  const maxLen = Math.max(0, ...lengths);
  const blCount = new Uint32Array(maxLen + 1);
  for (let i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const nextCode = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const len = lengths[i];
    if (len > 0) codes[i] = nextCode[len]++;
  }
  return { codes, lengths };
}

/** Reverse `nbits` bits (DEFLATE writes Huffman codes MSB-first into an LSB-first stream). */
export function reverseBits(code, nbits) {
  let r = 0;
  for (let i = 0; i < nbits; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

/**
 * Encode the code lengths (lit 0..287, dist 0..31) with RLE into symbols,
 * and build the code-length code (max 7 bits). Exactly hlit+hdist lengths
 * are encoded (hlit = last nonzero lit + 1, min 257; hdist likewise, min 1).
 * Returns {symbols, clLengths, hlit, hdist}.
 */
export function encodeCodeLengths(litLen, distLen) {
  let hlit = 288, hdist = 32;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const total = hlit + hdist;
  const all = new Uint8Array(total);
  all.set(litLen.subarray(0, hlit), 0);
  all.set(distLen.subarray(0, hdist), hlit);
  const syms = [];
  let i = 0;
  while (i < total) {
    const v = all[i];
    if (v === 0) {
      let run = 0;
      while (i + run < total && all[i + run] === 0) run++;
      while (run >= 11) {
        const take = Math.min(run, 138);
        syms.push([18, take - 11, 7]);
        i += take; run -= take;
      }
      if (run >= 3) { syms.push([17, run - 3, 3]); i += run; }
      else { for (let k = 0; k < run; k++) syms.push([0, 0, 0]); i += run; }
    } else {
      syms.push([v, 0, 0]);
      i++;
      let run = 0;
      while (i + run < total && all[i + run] === v) run++;
      while (run >= 3) {
        const take = Math.min(run, 6);
        syms.push([16, take - 3, 2]);
        i += take; run -= take;
      }
      for (let k = 0; k < run; k++) { syms.push([v, 0, 0]); i++; }
    }
  }
  const clFreq = new Uint32Array(19);
  for (const [s] of syms) clFreq[s]++;
  const clLengths = ensureTwoCodes(huffmanLengths(clFreq, 7));
  return { symbols: syms, clLengths, hlit, hdist };
}

/** Write a dynamic Huffman block header (HLIT/HDIST/HCLEN + code lengths). */
export function writeDynamicHeader(w, litLen, distLen) {
  const { symbols, clLengths, hlit, hdist } = encodeCodeLengths(litLen, distLen);
  const { codes: clCodes } = canonicalCodes(clLengths);
  let hclen = 19;
  while (hclen > 4 && clLengths[CL_ORDER[hclen - 1]] === 0) hclen--;
  w.write(hlit - 257, 5);
  w.write(hdist - 1, 5);
  w.write(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.write(clLengths[CL_ORDER[k]], 3);
  for (const [s, extra, extraBits] of symbols) {
    w.write(reverseBits(clCodes[s], clLengths[s]), clLengths[s]);
    if (extraBits > 0) w.write(extra, extraBits);
  }
}

/* ------------------------------------------------------------------ */
/* LZ77 matching + optimal parse                                       */
/* ------------------------------------------------------------------ */

const WINDOW = 32768;
const MAX_MATCH = 258;
const MIN_MATCH = 3;
const HASH_BITS = 18;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
/** How many chain entries a position's match search walks at most. */
const CHAIN_LIMIT = 512;
/** How many distinct-distance candidates a position keeps. */
const MAX_CAND = 4;
/** Block size for the deflate stream (bytes of filtered data). */
const BLOCK_SIZE = 200000;
/** DP passes: pass 0 uses fixed-Huffman costs, later passes refine. */
const DP_PASSES = 3;

function hash3(d, i) {
  return ((d[i] << 10) ^ (d[i + 1] << 5) ^ d[i + 2]) & HASH_MASK;
}

/** Match length of data[j..] vs data[i..], capped at `cap`. Verifies all bytes
 * (the 3-byte hash can collide, so the first bytes must be checked too). */
function matchLen(d, i, j, cap) {
  let k = 0;
  const n = Math.min(cap, d.length - i, d.length - j);
  while (k < n && d[i + k] === d[j + k]) k++;
  return k;
}

/**
 * One deflate block's optimal parse. `d` is the whole input, [bs, be) the block.
 * `head`/`prev` are the global hash chains (positions < bs already inserted).
 * `litLen`/`distLen` are the current cost model's code lengths.
 * Returns {tokens, litFreq, distFreq} where tokens is an array of
 * {lit} or {len, dist}. Candidates are found once and reused across passes.
 */
export class BlockEncoder {
  constructor(data) {
    this.d = data;
    this.head = new Int32Array(HASH_SIZE).fill(-1);
    this.prev = new Int32Array(data.length).fill(-1);
    this.insertedUpTo = 0;
  }

  /** Insert positions [from, to) into the hash chains. */
  insertRange(from, to) {
    const { d, head, prev } = this;
    for (let i = from; i < to; i++) {
      if (i + 2 >= d.length) break;
      const h = hash3(d, i);
      prev[i] = head[h];
      head[h] = i;
    }
    this.insertedUpTo = Math.max(this.insertedUpTo, to);
  }

  /**
   * Find match candidates for every position in [bs, be): up to MAX_CAND
   * (len, dist) pairs with distinct distances. Inserts positions as it goes.
   * Returns {candLen, candDist, candCount} flat arrays (n x MAX_CAND).
   */
  findCandidates(bs, be) {
    const { d, head, prev } = this;
    const n = be - bs;
    const candLen = new Uint16Array(n * MAX_CAND);
    const candDist = new Uint16Array(n * MAX_CAND);
    const candCount = new Uint8Array(n);
    // Positions before bs must already be inserted.
    if (this.insertedUpTo < bs) this.insertRange(this.insertedUpTo, bs);
    for (let i = bs; i < be; i++) {
      const p = i - bs;
      if (i + 2 < d.length && be - i >= MIN_MATCH) {
        const h = hash3(d, i);
        const cap = Math.min(MAX_MATCH, be - i);
        let j = head[h];
        let steps = 0;
        let best = 0, bestDist = 0;
        // Pareto-optimal candidates: each beats every earlier one in length,
        // at increasing distance (the chain runs newest-first). A candidate
        // that cannot beat `best` is dominated, so one probe byte rejects it.
        const dists = [];
        const lens = [];
        while (j >= 0 && steps < CHAIN_LIMIT) {
          const dist = i - j;
          if (dist > WINDOW) break;
          let len = 0;
          if (best === 0) {
            // Verify the first 3 bytes (the hash can collide), then measure.
            if (d[j] === d[i] && d[j + 1] === d[i + 1] && d[j + 2] === d[i + 2]) {
              len = matchLen(d, i, j, cap);
            }
          } else if (best < cap && d[j + best] === d[i + best]) {
            len = matchLen(d, i, j, cap);
          }
          if (len >= MIN_MATCH && len > best) {
            best = len;
            bestDist = dist;
            dists.push(dist);
            lens.push(len);
            if (best >= 128) break;
          }
          j = prev[j];
          steps++;
          // Diminishing returns: a long walk that only finds short matches
          // is unlikely to pay off, so stop early (zlib's good_match idea).
          if (steps >= 256 && best < 32) break;
          if (steps >= 64 && best < 8) break;
        }
        // Store candidates: the first (nearest) plus the longest ones.
        // `lens` is strictly increasing (Pareto), so the longest are last.
        // The DP wants both a cheap near match and the longest matches.
        let cnt = 0;
        if (lens.length > 0) {
          candLen[p * MAX_CAND + cnt] = lens[0];
          candDist[p * MAX_CAND + cnt] = dists[0];
          cnt++;
          for (let k = lens.length - 1; k >= 1 && cnt < MAX_CAND; k--) {
            candLen[p * MAX_CAND + cnt] = lens[k];
            candDist[p * MAX_CAND + cnt] = dists[k];
            cnt++;
          }
        }
        candCount[p] = cnt;
      }
      // Insert this position for later positions.
      if (i + 2 < d.length) {
        const h = hash3(d, i);
        prev[i] = head[h];
        head[h] = i;
      }
    }
    this.insertedUpTo = Math.max(this.insertedUpTo, be);
    return { candLen, candDist, candCount };
  }
}

/** Cost tables from code lengths: litCost[byte], lenCost[len], distCost[dist]. */
function costTables(litLen, distLen) {
  const litCost = new Float64Array(286);
  for (let i = 0; i < 286; i++) litCost[i] = litLen[i];
  const lenCost = new Float64Array(MAX_MATCH + 1);
  for (let len = MIN_MATCH; len <= MAX_MATCH; len++) {
    const { code, extraBits } = lengthCode(len);
    lenCost[len] = litLen[code] + extraBits;
  }
  const distCost = new Float64Array(WINDOW + 1);
  for (let dist = 1; dist <= WINDOW; dist++) {
    const { code, extraBits } = distanceCode(dist);
    distCost[dist] = distLen[code] + extraBits;
  }
  return { litCost, lenCost, distCost };
}

/**
 * Dynamic-programming optimal parse of one block's candidates.
 * Returns {tokens, litFreq, distFreq, bitCost} for the given cost model.
 */
export function optimalParse(d, bs, be, cands, litLen, distLen) {
  const n = be - bs;
  const { litCost, lenCost, distCost } = costTables(litLen, distLen);
  const cost = new Float64Array(n + 1).fill(Infinity);
  const choiceLen = new Int16Array(n + 1);
  const choiceDist = new Int32Array(n + 1);
  cost[0] = 0;
  const { candLen, candDist, candCount } = cands;
  for (let i = 0; i < n; i++) {
    const c = cost[i];
    if (c === Infinity) continue;
    // Literal.
    const lc = c + litCost[d[bs + i]];
    if (lc < cost[i + 1]) {
      cost[i + 1] = lc;
      choiceLen[i + 1] = 0;
      choiceDist[i + 1] = 0;
    }
    // Matches: for each candidate, a reduced set of lengths.
    const cnt = candCount[i];
    for (let k = 0; k < cnt; k++) {
      const L = candLen[i * MAX_CAND + k];
      const D = candDist[i * MAX_CAND + k];
      const dc = distCost[D];
      // Lengths: 3..min(L,8) and L-7..L (deduped), all within [3, L].
      const hi = Math.min(L, 8);
      for (let len = MIN_MATCH; len <= hi; len++) {
        const nc = c + lenCost[len] + dc;
        if (nc < cost[i + len]) {
          cost[i + len] = nc;
          choiceLen[i + len] = len;
          choiceDist[i + len] = D;
        }
      }
      for (let len = Math.max(9, L - 7); len <= L; len++) {
        const nc = c + lenCost[len] + dc;
        if (nc < cost[i + len]) {
          cost[i + len] = nc;
          choiceLen[i + len] = len;
          choiceDist[i + len] = D;
        }
      }
    }
  }
  // Walk back to tokens.
  const tokens = [];
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(32);
  let i = n;
  while (i > 0) {
    const len = choiceLen[i];
    if (len === 0) {
      const sym = d[bs + i - 1];
      tokens.push({ lit: sym });
      litFreq[sym]++;
      i--;
    } else {
      const dist = choiceDist[i];
      const { code: lc } = lengthCode(len);
      const { code: dc } = distanceCode(dist);
      tokens.push({ len, dist });
      litFreq[lc]++;
      distFreq[dc]++;
      i -= len;
    }
  }
  tokens.reverse();
  litFreq[256]++; // end of block
  return { tokens, litFreq, distFreq, bitCost: cost[n] };
}

/**
 * A Huffman alphabet with a single code of length 1 is incomplete
 * (Kraft sum 0.5) and the decoder rejects it ("invalid code lengths set").
 * Give a second, unused symbol length 1 so the code is complete. The dummy
 * is never emitted by a token, so it costs only a few header bits.
 */
export function ensureTwoCodes(lengths) {
  let count = 0;
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) count++;
  if (count === 1) {
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i] === 0) { lengths[i] = 1; break; }
    }
  }
  return lengths;
}

/**
 * Cost-model lengths from refined Huffman lengths: a symbol the parse never
 * used gets length 0 in the refined code, but the DP can still emit it, and
 * a length of 0 reads as free, so the next pass would abuse it (emitting
 * thousands of "free" literals). Unused symbols keep the fixed length as
 * their cost instead. The refined lengths stay the emission lengths.
 */
function mergeLengths(refined, fixed) {
  const out = new Uint8Array(refined.length);
  for (let i = 0; i < refined.length; i++) out[i] = refined[i] > 0 ? refined[i] : fixed[i];
  return out;
}
/** Bits to emit `tokens` with the given lengths (dynamic block, header excluded). */
function tokensBitCost(tokens, litLen, distLen) {
  let bits = 0;
  for (const t of tokens) {
    if (t.lit !== undefined) bits += litLen[t.lit];
    else {
      const { code: lc, extraBits: le } = lengthCode(t.len);
      const { code: dc, extraBits: de } = distanceCode(t.dist);
      bits += litLen[lc] + le + distLen[dc] + de;
    }
  }
  bits += litLen[256];
  return bits;
}

/** Emit `tokens` into bit writer `w` with the given lengths. */
function emitTokens(w, tokens, litCodes, litLen, distCodes, distLen) {
  for (const t of tokens) {
    if (t.lit !== undefined) {
      w.write(reverseBits(litCodes[t.lit], litLen[t.lit]), litLen[t.lit]);
    } else {
      const { code: lc, extra, extraBits: le } = lengthCode(t.len);
      const { code: dc, extra: dextra, extraBits: de } = distanceCode(t.dist);
      w.write(reverseBits(litCodes[lc], litLen[lc]), litLen[lc]);
      if (le > 0) w.write(extra, le);
      w.write(reverseBits(distCodes[dc], distLen[dc]), distLen[dc]);
      if (de > 0) w.write(dextra, de);
    }
  }
  w.write(reverseBits(litCodes[256], litLen[256]), litLen[256]);
}

/**
 * Deflate `data` (a Uint8Array of filtered bytes) into one zlib stream.
 * One BitWriter carries the whole stream: DEFLATE blocks join at the bit
 * level, never at byte boundaries. Returns a Uint8Array holding the zlib stream.
 */
export function deflate(data) {
  const enc = new BlockEncoder(data);
  // Capacity in bytes: worst case ~15 bits per input byte plus headers.
  const w = new BitWriter(data.length * 2 + 65536);
  w.write(0x78, 8); // zlib header, default compression, 32K window
  w.write(0x9c, 8);
  const n = data.length;
  for (let bs = 0; bs < n; bs += BLOCK_SIZE) {
    const be = Math.min(n, bs + BLOCK_SIZE);
    const last = be >= n;
    const cands = enc.findCandidates(bs, be);
    // DP passes: fixed costs first, then refined lengths. The cost model for
    // the next pass merges refined lengths with the fixed ones (unused
    // symbols keep a real cost); the emission keeps the refined lengths.
    // Keep the best pass by its true cost under its own Huffman, not the last.
    let costLit = FIXED_LIT_LEN, costDist = FIXED_DIST_LEN;
    let best = null, bestLit = FIXED_LIT_LEN, bestDist = FIXED_DIST_LEN, bestBits = Infinity;
    for (let pass = 0; pass < DP_PASSES; pass++) {
      const r = optimalParse(data, bs, be, cands, costLit, costDist);
      // Refine lengths from this parse's frequencies.
      const ll = huffmanLengths(r.litFreq, 15);
      const dl = huffmanLengths(r.distFreq, 15);
      // A dist alphabet with no matches needs one dummy code (never emitted).
      if (r.distFreq.every((x) => x === 0)) dl[0] = 1;
      const bits = tokensBitCost(r.tokens, ll, dl);
      if (bits < bestBits) { best = r; bestLit = ll; bestDist = dl; bestBits = bits; }
      costLit = mergeLengths(ll, FIXED_LIT_LEN);
      costDist = mergeLengths(dl, FIXED_DIST_LEN);
    }
    const litLen = ensureTwoCodes(bestLit.slice());
    const distLen = ensureTwoCodes(bestDist.slice());
    // Choose dynamic vs fixed Huffman for this block.
    const dynBits = bestBits;
    const fixBits = tokensBitCost(best.tokens, FIXED_LIT_LEN, FIXED_DIST_LEN);
    // Dynamic header is roughly 300-600 bits; use it only when it wins.
    // A used symbol with length 0 would be read as free by the DP and is
    // not a valid code: fall back to fixed Huffman for such a block.
    let dynamicValid = true;
    for (let s = 0; s < 288; s++) if (best.litFreq[s] > 0 && litLen[s] === 0) dynamicValid = false;
    for (let s = 0; s < 32; s++) if (best.distFreq[s] > 0 && distLen[s] === 0) dynamicValid = false;
    const useDynamic = dynamicValid && dynBits + 400 < fixBits;
    w.write(last ? 1 : 0, 1);
    if (useDynamic) {
      w.write(2, 2);
      writeDynamicHeader(w, litLen, distLen);
      const { codes: litCodes } = canonicalCodes(litLen);
      const { codes: distCodes } = canonicalCodes(distLen);
      emitTokens(w, best.tokens, litCodes, litLen, distCodes, distLen);
    } else {
      w.write(1, 2);
      const { codes: litCodes } = canonicalCodes(FIXED_LIT_LEN);
      const { codes: distCodes } = canonicalCodes(FIXED_DIST_LEN);
      emitTokens(w, best.tokens, litCodes, FIXED_LIT_LEN, distCodes, FIXED_DIST_LEN);
    }
  }
  const body = w.finish();
  const out = new Uint8Array(body.length + 4);
  out.set(body, 0);
  const ad = adler32(data);
  out[body.length] = (ad >>> 24) & 0xff;
  out[body.length + 1] = (ad >>> 16) & 0xff;
  out[body.length + 2] = (ad >>> 8) & 0xff;
  out[body.length + 3] = ad & 0xff;
  return out;
}
