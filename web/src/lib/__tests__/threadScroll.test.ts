import { describe, expect, it } from "vitest";
import { threadScrollTarget } from "@/lib/threadScroll";

/**
 * Issue #87: a conversation opened on its newest message, so unread mail sat
 * above the fold with nothing to announce it but a marker you had to scroll up
 * to see — and the auto-mark-read timer marked it read while you were still
 * looking at the bottom of the thread.
 *
 * The case that makes "second to last" the wrong answer is out-of-order
 * delivery: a message sent hours ago but queued on the sender's server arrives
 * last and sorts early. Messages here are in the order the pane renders them,
 * oldest first, which is receivedAt order.
 */

const thread = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}` }));
const unread = (...ids: string[]) => new Set(ids);

describe("where a conversation opens", () => {
  it("opens on the oldest unread message", () => {
    expect(threadScrollTarget(thread(5), unread("m3", "m4"))).toBe("m3");
  });

  it("opens on an unread message that arrived late and sorted early", () => {
    // The one the issue is about: m2 was delivered after m5, so opening at the
    // bottom hides it three messages up.
    expect(threadScrollTarget(thread(5), unread("m2"))).toBe("m2");
  });

  it("opens on the newest message when the thread is all read", () => {
    expect(threadScrollTarget(thread(5), unread())).toBe("m5");
  });
});

describe("when it leaves the pane where it is", () => {
  it("stays at the top when the first message is the unread one", () => {
    // Scrolling to it would push the subject off the top for nothing.
    expect(threadScrollTarget(thread(4), unread("m1", "m3"))).toBeNull();
  });

  it("does not scroll a single message", () => {
    expect(threadScrollTarget(thread(1), unread("m1"))).toBeNull();
  });

  it("does not scroll an empty thread", () => {
    expect(threadScrollTarget([], unread())).toBeNull();
  });
});
