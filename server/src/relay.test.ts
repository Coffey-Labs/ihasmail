import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
process.env.STALWART_URL = "http://127.0.0.1:1";
const { relayPushRaw } = await import("./app.js");

/*
 * Stalwart sends no headers on its event stream until its first ping (issue
 * #71). The fake upstream here does the same, after a delay, and the browser
 * side must not wait for it.
 */
async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function relayServer(upstreamUrl: string) {
  return http.createServer((req, res) => {
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const c = { env: { outgoing: res }, req: { raw: { signal: ac.signal } } };
    relayPushRaw(c as never, upstreamUrl, "Basic x");
    void req;
  });
}

test("a relayed push stream answers before the upstream sends anything", async () => {
  const upstream = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: ping\ndata: {"interval": 30}\n\n');
    }, 1500);
  });
  const relay = relayServer(`${await listen(upstream)}/jmap/eventsource/`);
  const base = await listen(relay);
  try {
    const started = Date.now();
    const res = await fetch(`${base}/api/events`);
    assert.ok(Date.now() - started < 1000, "headers must not wait for the upstream");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    while (!text.includes("event: ping")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    assert.ok(text.startsWith(": relay\n\n"), "a comment line goes out first");
    assert.ok(text.includes("event: ping"), "the upstream's events still come through");
    await reader.cancel();
  } finally {
    relay.closeAllConnections(); upstream.closeAllConnections();
    relay.close(); upstream.close();
  }
});

test("an upstream refusal ends the relayed stream", async () => {
  const upstream = http.createServer((_req, res) => { res.writeHead(401); res.end(); });
  const relay = relayServer(`${await listen(upstream)}/jmap/eventsource/`);
  const base = await listen(relay);
  try {
    const res = await fetch(`${base}/api/events`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), ": relay\n\n");
  } finally {
    relay.closeAllConnections(); upstream.closeAllConnections();
    relay.close(); upstream.close();
  }
});
