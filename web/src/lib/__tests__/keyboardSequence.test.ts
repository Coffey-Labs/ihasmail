import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyboard } from "@/lib/keyboard";

/*
 * Two-key sequences against the single keys they start with.
 *
 * "Go to folder" is `g o` while `o` on its own opens a conversation (#233), so
 * the whole feature rests on a pending prefix being tried before a bare key.
 * That was true when it was written and nothing said so out loud, which is the
 * kind of thing a later refactor quietly reverses.
 */

const press = (key: string) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
};

let pop: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  pop?.();
  pop = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a sequence sharing its second key with a single binding", () => {
  it("runs the sequence, not the single key", () => {
    const seq = vi.fn();
    const single = vi.fn();
    pop = keyboard.pushScope("t", [
      { keys: "g o", description: "Go to folder", group: "Navigation", handler: seq },
      { keys: "o", description: "Open", group: "Mail", handler: single },
    ]);
    press("g");
    press("o");
    expect(seq).toHaveBeenCalledOnce();
    expect(single).not.toHaveBeenCalled();
  });

  it("runs the single key when no prefix is pending", () => {
    const seq = vi.fn();
    const single = vi.fn();
    pop = keyboard.pushScope("t", [
      { keys: "g o", description: "Go to folder", group: "Navigation", handler: seq },
      { keys: "o", description: "Open", group: "Mail", handler: single },
    ]);
    press("o");
    expect(single).toHaveBeenCalledOnce();
    expect(seq).not.toHaveBeenCalled();
  });

  it("forgets the prefix after a pause, so a later key means itself again", () => {
    const seq = vi.fn();
    const single = vi.fn();
    pop = keyboard.pushScope("t", [
      { keys: "g o", description: "Go to folder", group: "Navigation", handler: seq },
      { keys: "o", description: "Open", group: "Mail", handler: single },
    ]);
    press("g");
    vi.advanceTimersByTime(2000);
    press("o");
    expect(seq).not.toHaveBeenCalled();
    expect(single).toHaveBeenCalledOnce();
  });

  it("swallows the prefix rather than letting it act on its own", () => {
    // `g` is not a binding by itself; pressing it must not fall through to
    // anything, or holding it would type into the page.
    const seq = vi.fn();
    pop = keyboard.pushScope("t", [
      { keys: "g o", description: "Go to folder", group: "Navigation", handler: seq },
    ]);
    const e = press("g");
    expect(e.defaultPrevented).toBe(true);
    expect(seq).not.toHaveBeenCalled();
  });

  it("lets a key that completes no sequence still act as itself", () => {
    /*
     * `g` then `z`, where `g z` is nothing. The prefix is dropped and `z` runs
     * on that same press rather than being eaten — so a mistyped prefix costs
     * the prefix and not the keystroke after it.
     */
    const seq = vi.fn();
    const single = vi.fn();
    pop = keyboard.pushScope("t", [
      { keys: "g o", description: "Go to folder", group: "Navigation", handler: seq },
      { keys: "z", description: "Zed", group: "Mail", handler: single },
    ]);
    press("g");
    press("z");
    expect(seq).not.toHaveBeenCalled();
    expect(single).toHaveBeenCalledOnce();
  });
});
