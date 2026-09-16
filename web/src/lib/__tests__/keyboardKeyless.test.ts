import { afterEach, describe, expect, it, vi } from "vitest";
import { comboOf, keyboard } from "@/lib/input/keyboard";

/*
 * A "keydown" that carries no key. Chrome's password autofill dispatches one
 * as a plain Event when a saved login is picked, and comboOf read `key.length`
 * off it -- an uncaught TypeError in the console on every sign-in.
 */

let pop: (() => void) | null = null;

afterEach(() => {
  pop?.();
  pop = null;
});

describe("a keydown with no key", () => {
  it("has no combo", () => {
    expect(comboOf(new Event("keydown") as KeyboardEvent)).toBeNull();
  });

  it("reaches no binding and throws nothing", () => {
    const handler = vi.fn();
    pop = keyboard.pushScope("test", [{ keys: "e", description: "Archive", group: "Mail", handler }]);
    const errors: unknown[] = [];
    const onError = (ev: ErrorEvent) => errors.push(ev.error);
    window.addEventListener("error", onError);
    try {
      window.dispatchEvent(new Event("keydown", { bubbles: true }));
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(errors).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves real keys alone", () => {
    expect(comboOf(new KeyboardEvent("keydown", { key: "e" }))).toBe("e");
    expect(comboOf(new KeyboardEvent("keydown", { key: "E", shiftKey: true }))).toBe("E");
    expect(comboOf(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }))).toMatch(/enter$/);
  });
});
