// png-squeeze-01 entry: PNG codec written for this entry (Node 22, stdlib only).
// Reads the PNGs the contest accepts (8-bit, non-interlaced, colour types 0/2/3/4/6,
// only IHDR, PLTE, tRNS, IDAT, IEND) and writes them back. Lossless: every pixel's
// four channels decode exactly, a fully transparent pixel's colour too.

import { inflateSync } from 'node:zlib';

export const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
export const CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });
const CHUNKS = ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

/** A PNG file of [type, data] chunks: signature, then each chunk with length + CRC. */
export function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

/** IHDR data: width, height, bit depth 8, colour type, compression 0, filter 0, no interlace. */
export function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

/** Paeth predictor of PNG filter 4. */
export function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Filter row `cur` (stride samples, bpp per pixel, `prev` the row above or null) by `type` into out. */
export function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

/** Sum of a filtered row's bytes read as signed (-128..127), absolute. */
export function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const fail = (why) => ({ ok: false, why });

/**
 * The image a PNG holds, as RGBA (4 bytes a pixel, rows top to bottom),
 * or why it is not one the contest reads. `expect` {width, height} when given.
 */
export function decodePng(bytes, expect = null) {
  if (!(bytes instanceof Uint8Array)) return fail('it is not bytes');
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) return fail('it does not start with the PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header = null, palette = null, trns = null;
  const idat = [];
  let idatDone = false, ended = false;
  while (at < bytes.length) {
    if (ended) return fail('it holds bytes after IEND');
    if (at + 12 > bytes.length) return fail(`a chunk at byte ${at} is cut short`);
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return fail(`the chunk at byte ${at} claims ${len} bytes the file does not hold`);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) return fail(`the chunk at byte ${at} has no chunk type (four letters)`);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return fail(`the ${type} chunk at byte ${at} fails its CRC`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (!CHUNKS.includes(type)) return fail(`it holds a ${type} chunk, and only ${CHUNKS.join(', ')} are read`);
    if (header === null && type !== 'IHDR') return fail(`its first chunk is ${type}, not IHDR`);
    if (type !== 'IDAT' && idat.length > 0) idatDone = true;
    if (type === 'IHDR') {
      if (header !== null) return fail('it holds IHDR twice');
      if (len !== 13) return fail('its IHDR is not 13 bytes');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], compression: data[10], filter: data[11], interlace: data[12] };
      if (header.width === 0 || header.height === 0) return fail('its width or height is 0');
      if (expect !== null && (header.width !== expect.width || header.height !== expect.height)) return fail(`it is ${header.width} x ${header.height}, not ${expect.width} x ${expect.height}`);
      if (header.depth !== 8) return fail(`its bit depth is ${header.depth}, not 8`);
      if (!Object.hasOwn(CHANNELS, header.colourType)) return fail(`its colour type is ${header.colourType}, not 0, 2, 3, 4 or 6`);
      if (header.compression !== 0 || header.filter !== 0) return fail('its compression or filter method is not 0');
      if (header.interlace !== 0) return fail('it is interlaced');
    } else if (type === 'PLTE') {
      if (palette !== null) return fail('it holds PLTE twice');
      if (header.colourType !== 3) return fail(`it holds PLTE with colour type ${header.colourType} (only type 3 takes one)`);
      if (idat.length > 0) return fail('its PLTE follows IDAT');
      if (len === 0 || len % 3 !== 0 || len > 768) return fail('its PLTE is not 1 to 256 entries of 3 bytes');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null) return fail('it holds tRNS twice');
      if (idat.length > 0) return fail('its tRNS follows IDAT');
      const ct = header.colourType;
      if (ct === 3) {
        if (palette === null) return fail('its tRNS comes before PLTE');
        if (len > palette.length / 3) return fail('its tRNS holds more entries than its palette');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) return fail(`its tRNS is not ${ct === 0 ? 2 : 6} bytes for colour type ${ct}`);
        for (let i = 0; i < len; i += 2) if (data[i] !== 0) return fail('its tRNS names a sample over 255');
      } else return fail(`it holds tRNS with colour type ${ct}`);
      trns = data;
    } else if (type === 'IDAT') {
      if (idatDone) return fail('its IDAT chunks are not in a row');
      if (header.colourType === 3 && palette === null) return fail('its IDAT comes before PLTE (colour type 3 needs one)');
      idat.push(data);
    } else {
      if (len !== 0) return fail('its IEND is not empty');
      ended = true;
    }
  }
  if (!ended) return fail('it has no IEND');
  if (idat.length === 0) return fail('it has no IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (!Number.isSafeInteger(expected) || expected > 1 << 30) return fail('its image is too large to read');
  let raw;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (err) {
    return fail(`its IDAT data is not one whole zlib stream of ${expected} bytes (${String(err && err.message).split('\n')[0]})`);
  }
  if (raw.length !== expected) return fail(`its IDAT data inflates to ${raw.length} bytes, not ${expected}`);

  // Unfilter in place, row by row.
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return fail(`row ${y} has filter type ${ft}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }

  // Expand to RGBA.
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return fail(`pixel (${i % width}, ${Math.floor(i / width)}) names palette entry ${e} of ${entries}`);
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { ok: true, width, height, colourType, rgba };
}
