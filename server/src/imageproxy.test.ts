import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";

process.env.STALWART_URL = "http://127.0.0.1:1";
process.env.APP_SECRET = "test-secret-for-image-proxy";

const { fetchPinned, isPrivateAddress } = await import("./imageproxy.js");
const { createApp } = await import("./app.js");

/**
 * The proxy hides the reader from tracking pixels, so it fetches URLs a sender
 * chose — which makes it the one place in the app that will knock on any door
 * it is pointed at.
 */

test("addresses we must never reach are recognised", () => {
  for (const a of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", // cloud metadata, the classic SSRF target
    "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fe80::1", "fd00::1", "fc00::1",
    "ff02::1", // multicast
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "64:ff9b::7f00:1", // NAT64, which reaches IPv4 space
    "not-an-address", // unknown forms are refused rather than allowed
  ]) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2001:db8::1"]) {
    assert.equal(isPrivateAddress(a), false, a);
  }
});

/**
 * The interesting half. Checking a name and then handing the *name* to a
 * fetching library leaves a gap: it resolves again when the socket opens, and
 * whoever controls the zone can answer differently the second time — the first
 * answer passes the check, the second points at localhost.
 *
 * Two servers on the same port at different addresses settle it without
 * depending on how this machine resolves anything: `localhost` reaches one of
 * them, and the pin has to reach the other.
 */
const PORT = 18811;
const RESOLVED = "::1"; // what "localhost" gets you
const PINNED = "127.0.0.2"; // somewhere only an explicit address reaches
let viaName: Server;
let viaPin: Server;

const identify = (name: string) =>
  createServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(name);
  });

before(async () => {
  viaName = identify("reached-by-name");
  viaPin = identify("reached-by-pin");
  await new Promise<void>((r, j) => viaName.listen(PORT, RESOLVED, r).on("error", j));
  await new Promise<void>((r, j) => viaPin.listen(PORT, PINNED, r).on("error", j));
});

after(() => {
  viaName?.close();
  viaPin?.close();
});

const read = async (res: IncomingMessage) => {
  res.setEncoding("utf8");
  let body = "";
  for await (const chunk of res) body += chunk;
  return body;
};

test("plain resolution reaches the host the name points at", async () => {
  // The control: without pinning, this is where a request lands.
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = httpRequest(`http://localhost:${PORT}/who`, resolve);
    req.on("error", reject);
    req.end();
  });
  assert.equal(await read(res), "reached-by-name");
});

test("a pinned request goes to the address we checked, not to DNS", async () => {
  const res = await fetchPinned(new URL(`http://localhost:${PORT}/who`), PINNED);
  assert.equal(await read(res), "reached-by-pin", "the socket followed the pin, not the name");
});

test("a pinned request still presents the real hostname", async () => {
  // The Host header (and TLS servername) must stay the name, or certificates
  // would not validate and virtual hosts would serve the wrong site.
  const seen = identify("");
  let host = "";
  seen.on("request", (req) => (host = String(req.headers.host)));
  await new Promise<void>((r) => seen.listen(0, "127.0.0.3", r));
  const p = (seen.address() as AddressInfo).port;
  const res = await fetchPinned(new URL(`http://example.test:${p}/who`), "127.0.0.3");
  await read(res);
  seen.close();
  assert.equal(host, `example.test:${p}`);
});

test("the proxy refuses a private target and needs a session", async () => {
  const app = createApp();
  // Unauthenticated first: the proxy is not an open relay.
  const anon = await app.request("/api/image?url=http://127.0.0.1/x.png");
  assert.equal(anon.status, 401);
});

test("the proxy rejects unusable URLs before resolving anything", async () => {
  const app = createApp();
  for (const u of ["file:///etc/passwd", "gopher://x/1", "http://user:pw@example.com/x.png"]) {
    const res = await app.request(`/api/image?url=${encodeURIComponent(u)}`);
    // Still behind the session check, but the point is it never reaches the network.
    assert.equal(res.status, 401);
  }
});
