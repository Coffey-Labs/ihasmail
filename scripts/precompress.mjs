#!/usr/bin/env node
/*
 * Write a Brotli and a gzip copy beside every compressible file in a web build.
 *
 * The server used to gzip the bundle again on every request that asked for it,
 * at a level chosen for speed. These are made once, at the level chosen for
 * size, and `server/src/static.ts` hands one out when the browser accepts it.
 * Brotli at 11 is about 15% smaller than gzip for this bundle, and too slow to
 * do per request, which is why it was never offered.
 *
 *   node scripts/precompress.mjs web/dist
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const COMPRESSIBLE = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".webmanifest", ".txt", ".wasm"]);
// Below this, the encoding costs more than it saves.
const MIN_BYTES = 1024;

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(p);
    else yield p;
  }
}

const root = process.argv[2];
if (!root) {
  console.error("usage: precompress.mjs <dir>");
  process.exit(2);
}
let count = 0;
let before = 0;
let after = 0;
for (const p of files(root)) {
  if (!COMPRESSIBLE.has(extname(p)) || statSync(p).size < MIN_BYTES) continue;
  const data = readFileSync(p);
  const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
  writeFileSync(`${p}.br`, br);
  writeFileSync(`${p}.gz`, gzipSync(data, { level: 9 }));
  count++;
  before += data.length;
  after += br.length;
}
console.log(`precompressed ${count} files: ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB brotli`);
