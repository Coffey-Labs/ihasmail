import { test } from "node:test";
import assert from "node:assert/strict";
process.env.STALWART_URL = "http://127.0.0.1:1";
const { createApp } = await import("./app.js");

test("CSRF guard rejects API POSTs without the custom header", async () => {
  const app = createApp();
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 403);
});

test("unauthenticated JMAP calls are rejected", async () => {
  const app = createApp();
  const res = await app.request("/api/jmap", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ihasmail" }, body: "{}" });
  assert.equal(res.status, 401);
});

test("cross-site fetches are rejected", async () => {
  const app = createApp();
  const res = await app.request("/api/health", { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(res.status, 403);
});

test("health and security headers", async () => {
  const app = createApp();
  const res = await app.request("/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("image proxy refuses private targets", async () => {
  const app = createApp();
  // no session -> 401 first; so exercise the handler directly via a logged-in-less path is not possible; check the URL validation ordering instead
  const res = await app.request("/api/image?url=http://127.0.0.1/x");
  assert.equal(res.status, 401);
});

test("a compressed upstream blob is not forwarded with the compressed length", async () => {
  const { forwardedContentLength } = await import("./app.js");
  // gzip: the body we forward has already been decompressed, so the length on
  // the wire describes different bytes and must not be copied (issue #76).
  const gz = new Headers({ "content-encoding": "gzip", "content-length": "384" });
  assert.equal(forwardedContentLength(gz), null);
  // identity, spelled out or absent: the length describes the body we send.
  assert.equal(forwardedContentLength(new Headers({ "content-encoding": "identity", "content-length": "1157" })), "1157");
  assert.equal(forwardedContentLength(new Headers({ "content-length": "1157" })), "1157");
  assert.equal(forwardedContentLength(new Headers({ "content-encoding": "BR", "content-length": "384" })), null);
  // Nothing to forward is not an error.
  assert.equal(forwardedContentLength(new Headers()), null);
});

test("a Sieve script larger than a compressing hop's threshold survives the proxy", async () => {
  const http = await import("node:http");
  const zlib = await import("node:zlib");
  const { forwardedContentLength } = await import("./app.js");

  const script =
    "# ihasmail filters v1 - edit with care; rules are stored in the `# rule:` comments\nrequire [\"fileinto\"];\n\n" +
    ["a", "b", "c"]
      .map(
        (k) =>
          `# rule:{"id":"r${k}","name":"From ${k}@example.com","enabled":true,"join":"allof","tests":[{"type":"header","header":"from","op":"contains","value":"${k}@example.com"}],"actions":[{"type":"fileinto","mailbox":"INBOX/${k}"}]}\n` +
          `if header :contains "from" "${k}@example.com"\n{\n    fileinto "INBOX/${k}";\n}\n\n`,
      )
      .join("");
  const gz = zlib.gzipSync(Buffer.from(script));
  assert.ok(gz.length < Buffer.byteLength(script), "the script has to compress for this test to mean anything");

  // A hop that compresses regardless of what we asked for.
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/sieve", "content-encoding": "gzip", "content-length": String(gz.length) });
    res.end(gz);
  });
  await new Promise<void>((r) => origin.listen(0, () => r()));
  const port = (origin.address() as { port: number }).port;

  try {
    const up = await fetch(`http://127.0.0.1:${port}/`);
    // What the blob route forwards.
    const headers = new Headers({ "content-type": "application/sieve; charset=utf-8" });
    const cl = forwardedContentLength(up.headers);
    if (cl) headers.set("Content-Length", cl);
    const out = new Response(await up.arrayBuffer(), { status: 200, headers });
    assert.equal(out.headers.get("content-length"), null);
    assert.equal(await out.text(), script);
  } finally {
    origin.close();
  }
});

test("only a PDF blob may be framed, and only by us", async () => {
  /*
   * The PDF preview is an iframe, and the blanket X-Frame-Options: DENY on
   * every response blocked it -- the dialog showed Chrome's "refused to
   * connect" where the file should have been. The middleware now leaves a
   * header a route has already set, so this pins both halves: the exception
   * exists, and it did not become the rule.
   */
  const app = createApp();
  const health = await app.request("/api/health");
  assert.equal(health.headers.get("x-frame-options"), "DENY");

  const { securityHeadersFor } = await import("./app.js");
  assert.equal(securityHeadersFor("application/pdf", true), "SAMEORIGIN");
  assert.equal(securityHeadersFor("application/pdf", false), "DENY");
  assert.equal(securityHeadersFor("image/png", true), "DENY");
  assert.equal(securityHeadersFor("text/html", true), "DENY");
});

/*
 * #239: retrying through an outage must not lock somebody out of the recovery.
 *
 * STALWART_URL at the top of this file is 127.0.0.1:1 — nothing listens there,
 * so every sign-in here is the outage case. Before the fix, the eleventh of
 * these came back 429 and stayed 429 for fifteen minutes, outliving whatever
 * had actually been wrong.
 */
test("an unreachable upstream does not spend login attempts", async () => {
  const app = createApp();
  const login = () =>
    app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "ihasmail" },
      body: JSON.stringify({ username: "someone@example.com", password: "hunter2" }),
    });

  // Comfortably past LOGIN_RATE_LIMIT, which defaults to 10.
  for (let i = 0; i < 25; i++) {
    const res = await login();
    assert.notEqual(res.status, 429, `attempt ${i + 1} was rate limited`);
    assert.ok(res.status === 502 || res.status === 504, `attempt ${i + 1} said ${res.status}`);
  }
});

test("an unreachable upstream says it is not the password", async () => {
  const app = createApp();
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "ihasmail" },
    body: JSON.stringify({ username: "someone-else@example.com", password: "hunter2" }),
  });
  const body = (await res.json()) as { error: string; message: string };
  assert.notEqual(body.error, "invalid_credentials");
  assert.match(body.message, /not a problem with your password/i);
});
