import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectShare, shareBody, SHARE_MAX_AGE_MS } from "@/lib/shareTarget";
import { SW_CACHE_NAME } from "@/lib/swCache";

/**
 * The handoff, from the tab's side. The worker's half cannot be exercised here
 * -- sw.js is copied to the build rather than imported, and there is no service
 * worker under a test runner -- so what is stood up below is the cache it
 * writes into, keyed and shaped exactly as `stashShare` leaves it.
 *
 * That shape is the contract between two files that never see each other, and
 * it is the thing worth pinning: a drift on either side is silent. Nothing
 * errors, a share simply arrives at an empty composer.
 */

interface Entry {
  body: BodyInit;
  type: string;
}

function fakeCaches(entries: Record<string, Entry>) {
  const store = new Map(Object.entries(entries));
  const cache = {
    match: vi.fn(async (key: string) => {
      const e = store.get(key);
      return e ? new Response(e.body, { headers: { "content-type": e.type } }) : undefined;
    }),
    delete: vi.fn(async (key: string) => store.delete(key)),
    put: vi.fn(async () => undefined),
  };
  vi.stubGlobal("caches", { open: vi.fn(async (name: string) => (name === SW_CACHE_NAME ? cache : { match: async () => undefined })) });
  return { cache, store };
}

/** What the worker writes, at the keys it writes them under. */
function stash(meta: Record<string, unknown>, files: { name: string; type: string; body: string }[] = []) {
  const entries: Record<string, Entry> = {};
  const index = files.map((f, i) => ({ key: `/ihasmail-share/${i}`, name: f.name, type: f.type }));
  entries["/ihasmail-share"] = { body: JSON.stringify({ at: Date.now(), files: index, ...meta }), type: "application/json" };
  for (const [i, f] of files.entries()) entries[`/ihasmail-share/${i}`] = { body: f.body, type: f.type };
  return entries;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("collecting a share", () => {
  it("finds nothing on an ordinary start, which is almost every start", async () => {
    fakeCaches({});
    await expect(collectShare()).resolves.toBeNull();
  });

  it("survives a browser with no cache storage at all", async () => {
    vi.stubGlobal("caches", undefined);
    await expect(collectShare()).resolves.toBeNull();
  });

  it("rebuilds the files, with their names and types intact", async () => {
    fakeCaches(stash({ title: "Holiday", text: "", url: "" }, [
      { name: "beach.png", type: "image/png", body: "pixels" },
      { name: "notes.txt", type: "text/plain", body: "later" },
    ]));
    const share = await collectShare();
    expect(share?.title).toBe("Holiday");
    expect(share?.files.map((f) => [f.name, f.type])).toEqual([["beach.png", "image/png"], ["notes.txt", "text/plain"]]);
    // The bytes made the trip, not just the index entry describing them.
    expect(share!.files[0]!.size).toBe("pixels".length);
  });

  it("leaves nothing behind, so it cannot be collected twice", async () => {
    const { store } = fakeCaches(stash({ text: "hello" }, [{ name: "a.txt", type: "text/plain", body: "x" }]));
    await collectShare();
    expect(store.size).toBe(0);
  });

  it("ignores one nobody came back for, and still clears it", async () => {
    // A share to a signed-out ihasmail waits through the sign-in page, so it
    // cannot expire quickly -- but it must expire, or it opens a composer full
    // of a forgotten photo on some unrelated morning.
    const { store } = fakeCaches(stash({ at: Date.now() - SHARE_MAX_AGE_MS - 1000, text: "stale" }));
    await expect(collectShare()).resolves.toBeNull();
    expect(store.size).toBe(0);
  });

  it("treats an empty share as no share", async () => {
    fakeCaches(stash({ title: "", text: "", url: "" }));
    await expect(collectShare()).resolves.toBeNull();
  });

  it("does not throw on a stash it cannot read", async () => {
    fakeCaches({ "/ihasmail-share": { body: "not json", type: "application/json" } });
    await expect(collectShare()).resolves.toBeNull();
  });
});

describe("the body a share turns into", () => {
  it("keeps the link when the text does not already carry it", () => {
    expect(shareBody({ text: "Look at this", url: "https://example.com/a" })).toBe("Look at this\n\nhttps://example.com/a");
  });

  it("does not repeat a link the sharing app already put in the text", () => {
    // Which field a link arrives in is up to whatever shared it, and they do
    // not agree. Appending unconditionally would double it more often than not.
    expect(shareBody({ text: "https://example.com/a", url: "https://example.com/a" })).toBe("https://example.com/a");
  });

  it("is just the link when that is all there was", () => {
    expect(shareBody({ text: "", url: "https://example.com/a" })).toBe("https://example.com/a");
  });

  it("is just the text when there was no link", () => {
    expect(shareBody({ text: "a thought", url: "" })).toBe("a thought");
  });
});
