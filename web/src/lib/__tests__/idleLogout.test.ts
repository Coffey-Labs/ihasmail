import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startIdleLogout, stopIdleLogout, IDLE_TIMEOUT_MS } from "@/lib/idleLogout";

describe("idle sign-out on an untrusted device", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stopIdleLogout();
    vi.useRealTimers();
  });

  it("signs out after five minutes of nothing happening", () => {
    const expire = vi.fn();
    startIdleLogout(expire);
    expect(IDLE_TIMEOUT_MS).toBe(5 * 60 * 1000);

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it("starts the clock again on any sign of a person", () => {
    const expire = vi.fn();
    startIdleLogout(expire);

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1000);
    window.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1000);
    expect(expire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it("fires once, not repeatedly, and stops listening afterwards", () => {
    const expire = vi.fn();
    startIdleLogout(expire);
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 3);
    expect(expire).toHaveBeenCalledTimes(1);

    // A late event must not resurrect a timer for a session that has ended.
    window.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 2);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it("stops cleanly, so a trusted sign-in is never signed out", () => {
    const expire = vi.fn();
    startIdleLogout(expire);
    stopIdleLogout();
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 2);
    expect(expire).not.toHaveBeenCalled();
  });
});
