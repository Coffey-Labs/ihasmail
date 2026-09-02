import type { Context } from "hono";
import { safeFetch, safeFetchStatus } from "./imageproxy.js";

/**
 * Fetching a calendar somebody has subscribed to.
 *
 * The browser cannot do this itself: a calendar URL belongs to whoever
 * published it and almost none of them send CORS headers, so the request has
 * to be made from here. That makes it the second place ihasmail reaches out to
 * an address a stranger chose, and it goes through exactly the same guard as
 * the first — `safeFetch` resolves the name, refuses private space on every
 * answer, pins the connection to the address it checked, and re-checks each
 * redirect. There is deliberately no second implementation of that.
 *
 * **Nothing is stored.** The text goes straight back to the browser, which
 * parses it and holds the result in memory for as long as the tab is open. The
 * server keeps no copy, no cache and no schedule, which is what lets an
 * immutable container serve this at all.
 */

/** Generous for a calendar, small enough that nobody can post a film through it. */
const MAX_ICS_BYTES = 4 * 1024 * 1024;

/**
 * Types a calendar is served as in practice. `text/plain` and the octet-stream
 * are here because a great many servers get this wrong, and refusing a real
 * calendar over a header the publisher chose badly helps nobody -- the parser
 * checks the content itself, which is the claim that actually matters.
 */
const ACCEPTABLE = new Set(["text/calendar", "text/plain", "application/octet-stream", "application/ics", ""]);

export async function icsProxyHandler(c: Context) {
  const got = await safeFetch(c.req.query("url") ?? "", 20_000);
  if (typeof got === "string") return c.json({ error: got }, safeFetchStatus(got) as 400);
  const { res, done } = got;

  if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
    done();
    res.resume();
    return c.json({ error: "fetch_failed", status: res.statusCode ?? 0 }, 502);
  }
  const type = (res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (!ACCEPTABLE.has(type)) {
    done();
    res.resume();
    return c.json({ error: "not_calendar", type }, 415);
  }
  const declared = Number(res.headers["content-length"] ?? "0");
  if (declared > MAX_ICS_BYTES) {
    done();
    res.resume();
    return c.json({ error: "too_large" }, 413);
  }

  // Read it here rather than streaming: the browser needs the whole document
  // to parse it, and the cap has to hold whether or not a length was declared.
  let total = 0;
  const chunks: Buffer[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      res.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > MAX_ICS_BYTES) {
          res.destroy();
          reject(new Error("too_large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve());
      res.on("error", reject);
    });
  } catch (err) {
    done();
    return c.json({ error: (err as Error).message === "too_large" ? "too_large" : "fetch_failed" }, 502);
  }
  done();

  return c.body(Buffer.concat(chunks).toString("utf8"), 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    // Never stored on disk, and never held by anything in between either.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}
