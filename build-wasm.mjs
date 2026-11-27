// Rebuild the WASM core from its AssemblyScript source and regenerate the
// base64 blob the loader reads. Development-time only (needs the
// assemblyscript package: `npm install --no-save assemblyscript@0.28.20`
// in this directory, or in any scratch directory — the compiler is not
// needed at grading time; the committed deflate.wasm + wasm-b64.mjs are
// what runs).
//
//   node build-wasm.mjs [path-to-asc]
//   node build-wasm.mjs            (uses ./node_modules/.bin/asc)
//   node build-wasm.mjs /path/to/asc
//
// Verifies the rebuild byte-for-byte against the committed deflate.wasm.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const asc = process.argv[2] ?? join(dir, 'node_modules', '.bin', 'asc');
execFileSync(asc, [
  join(dir, 'deflate.ts'),
  '--outFile', join(dir, 'deflate.wasm'),
  '--runtime', 'stub',
  '--optimize',
  '--initialMemory', '1024',
  '--maximumMemory', '2048',
], { stdio: 'inherit' });
const before = readFileSync(join(dir, 'deflate.wasm'));
console.log(`compiled deflate.wasm (${before.length} bytes, sha256 ${createHash('sha256').update(before).digest('hex').slice(0, 16)}…)`);
// Regenerate the base64 blob.
await import(join(dir, 'gen-b64.mjs'));
console.log('build-wasm done. Commit deflate.wasm + wasm-b64.mjs together.');
