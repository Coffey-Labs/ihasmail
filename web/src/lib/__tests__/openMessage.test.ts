import { describe, expect, it } from "vitest";
import { rowIsOpen, visibleMessages } from "../openMessage";

/*
 * Reported from the inbox: with conversation view off, the list showed the two
 * messages of a thread as separate rows -- correctly -- but clicking either one
 * highlighted *both* and filled the reading pane with all five messages of the
 * conversation.
 *
 * The setting reached only as far as `collapseThreads` on the query. These are
 * the two rules that were missing downstream.
 */

const msg = (id: string) => ({ id });

describe("which row is drawn as open", () => {
  it("marks only the opened message, not its siblings", () => {
    // The reported case: two rows, one thread, one of them opened.
    expect(rowIsOpen("m1", "t1", "m1", "t1")).toBe(true);
    expect(rowIsOpen("m2", "t1", "m1", "t1")).toBe(false);
  });

  it("still marks the whole thread when conversation view is on", () => {
    // No message singled out: every row of the open thread is part of what the
    // reading pane is showing, so every one of them is open.
    expect(rowIsOpen("m1", "t1", null, "t1")).toBe(true);
    expect(rowIsOpen("m2", "t1", null, "t1")).toBe(true);
    expect(rowIsOpen("m3", "t2", null, "t1")).toBe(false);
  });

  it("marks nothing when nothing is open", () => {
    expect(rowIsOpen("m1", "t1", null, null)).toBe(false);
  });

  it("does not mark a row whose thread is unknown", () => {
    // A row whose email has not loaded yet has no thread id; `undefined` must
    // not match a null openThreadId and light the row up.
    expect(rowIsOpen("m1", undefined, null, null)).toBe(false);
  });
});

describe("which messages the reading pane shows", () => {
  const thread = [msg("a"), msg("b"), msg("c")];

  it("shows just the opened message", () => {
    expect(visibleMessages(thread, "b")).toEqual([msg("b")]);
  });

  it("shows the whole thread when none is singled out", () => {
    expect(visibleMessages(thread, null)).toEqual(thread);
  });

  it("falls back to the thread when the id names nothing in it", () => {
    /*
     * Two ways to arrive here: a link shared by somebody whose conversation
     * view is on, and an `m` parameter left in the URL when the setting is
     * switched back. A conversation is a better answer to both than an empty
     * pane, which is what filtering to nothing would produce.
     */
    expect(visibleMessages(thread, "zzz")).toEqual(thread);
  });

  it("leaves an empty thread empty rather than inventing a message", () => {
    expect(visibleMessages([], "b")).toEqual([]);
  });
});
