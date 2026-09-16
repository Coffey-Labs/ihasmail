import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";

/*
 * The bundle goes out compressed once, at build time, and anything revalidated
 * can be answered with a 304.
 *
 * Before this the server gzipped the bundle again for every request that asked,
 * never offered Brotli, and sent no validator for the shell -- so each reload's
 * revalidation of index.html and sw.js downloaded them in full.
 */
const root = mkdtempSync(join(tmpdir(), "ihasmail-precompressed-"));
mkdirSync(join(root, "assets"));
const js = `console.log(${JSON.stringify("x".repeat(4000))});\n`;
writeFileSync(join(root, "assets", "app-a1b2c3.js"), js);
writeFileSync(join(root, "assets", "app-a1b2c3.js.br"), brotliCompressSync(js));
writeFileSync(join(root, "assets", "app-a1b2c3.js.gz"), gzipSync(js));
writeFileSync(join(root, "assets", "plain-d4e5f6.js"), js);
// A copy left over from an older build of the same name must not be served.
writeFileSync(join(root, "assets", "stale-000000.js"), js);
writeFileSync(join(root, "assets", "stale-000000.js.br"), brotliCompressSync("old"));
const old = new Date(Date.now() - 60_000);
utimesSync(join(root, "assets", "stale-000000.js.br"), old, old);
writeFileSync(join(root, "sw.js"), "/* worker */\n");
writeFileSync(join(root, "index.html"), "<!doctype html><title>t</title>");

process.env.STATIC_DIR = root;
process.env.STALWART_URL = "http://127.0.0.1:1";
const { createApp } = await import("./app.js");
const app = createApp();

const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });

test("Brotli is served where the browser takes it", async () => {
  const res = await get("/assets/app-a1b2c3.js", { "accept-encoding": "gzip, deflate, br" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "br");
  assert.equal(res.headers.get("vary"), "Accept-Encoding");
  assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString(), js);
});

test("gzip where Brotli is not accepted, and nothing where neither is", async () => {
  const gz = await get("/assets/app-a1b2c3.js", { "accept-encoding": "gzip, br;q=0" });
  assert.equal(gz.headers.get("content-encoding"), "gzip");
  assert.equal(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString(), js);
  const plain = await get("/assets/app-a1b2c3.js");
  assert.equal(plain.headers.get("content-encoding"), null);
  assert.equal(await plain.text(), js);
});

test("a file without a copy is compressed as before", async () => {
  const res = await get("/assets/plain-d4e5f6.js", { "accept-encoding": "gzip" });
  assert.equal(res.headers.get("content-encoding"), "gzip");
  assert.equal(gunzipSync(Buffer.from(await res.arrayBuffer())).toString(), js);
});

test("a copy older than its file is ignored", async () => {
  const res = await get("/assets/stale-000000.js", { "accept-encoding": "br" });
  assert.notEqual(res.headers.get("content-encoding"), "br");
});

test("the shell and the worker answer a revalidation with 304", async () => {
  for (const path of ["/", "/sw.js"]) {
    const first = await get(path);
    const etag = first.headers.get("etag");
    assert.ok(etag, `${path} carries a validator`);
    await first.arrayBuffer();
    const again = await get(path, { "if-none-match": etag! });
    assert.equal(again.status, 304, `${path} is not sent again`);
    assert.equal(await again.text(), "");
    const changed = await get(path, { "if-none-match": `"something-else"` });
    assert.equal(changed.status, 200);
  }
});
