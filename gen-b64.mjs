// Regenerate wasm-b64.mjs from deflate.wasm (run after recompiling deflate.ts).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const wasm = readFileSync(new URL('./deflate.wasm', import.meta.url));
const b64 = wasm.toString('base64');
const sha = createHash('sha256').update(wasm).digest('hex');
const lines = b64.match(/.{1,100}/g).join('\n');
const out = `// The compiled WebAssembly DEFLATE core (deflate.wasm), base64-encoded so
// the loader can instantiate it synchronously without reading a binary file.
// Generated from deflate.ts by build-wasm.mjs — do not hand-edit.
// sha256 of deflate.wasm: ${sha}
export const WASM_B64 = \`
${lines}\`;
`;
writeFileSync(new URL('./wasm-b64.mjs', import.meta.url), out);
console.log(`wasm-b64.mjs written (${b64.length} b64 chars, sha256 ${sha.slice(0, 16)}…)`);
