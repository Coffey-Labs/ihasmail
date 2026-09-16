import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompose } from "@/store/compose";
import { useSession } from "@/store/session";

/**
 * A message being written belongs to the session it was written in. On a
 * shared machine the next person to sign in -- after an idle sign-out, with no
 * reload in between -- used to find the last one's composer still open.
 */

beforeEach(() => {
  vi.useFakeTimers();
  useSession.setState({ status: "authenticated" });
});

afterEach(() => {
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  vi.useRealTimers();
});

describe("signing out", () => {
  it("closes every composer and stops sends that are still waiting", () => {
    const run = vi.fn(async () => {});
    const timer = window.setTimeout(() => void run(), 5000);
    useCompose.setState({
      drafts: [{ key: "d1", subject: "Half written" } as never],
      activeKey: "d1",
      pendingSends: { d2: { timer, toastId: 1, draft: { key: "d2" } as never, run } },
    });
    useSession.setState({ status: "anonymous" });
    expect(useCompose.getState().drafts).toEqual([]);
    expect(useCompose.getState().activeKey).toBeNull();
    expect(useCompose.getState().pendingSends).toEqual({});
    vi.advanceTimersByTime(10_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves the composer alone while still signed in", () => {
    useCompose.setState({ drafts: [{ key: "d1" } as never], activeKey: "d1" });
    useSession.setState({ pushConnected: true });
    expect(useCompose.getState().drafts).toHaveLength(1);
  });

  it("sends what is inside its undo window before the session goes", async () => {
    const run = vi.fn(async () => {});
    const timer = window.setTimeout(() => void run(), 5000);
    useCompose.setState({ pendingSends: { d2: { timer, toastId: 1, draft: { key: "d2" } as never, run } } });
    await useCompose.getState().flushPendingSends();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
