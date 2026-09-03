import { afterEach, describe, expect, it, vi } from "vitest";
import { isTextEntry, keyboard } from "@/lib/keyboard";

/*
 * Shortcuts after a click on a checkbox (#260).
 *
 * The guard that stops "a" archiving while you are typing into the search box
 * tested `tagName === "INPUT"`, which is also true of a checkbox. A checkbox
 * keeps focus after a click, so ticking "select all" disabled every shortcut
 * until the reader clicked somewhere else — and nothing about a checkbox
 * swallows a keystroke in the first place.
 */

const pressFrom = (el: Element, key: string) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

let pop: (() => void) | null = null;
afterEach(() => {
  pop?.();
  pop = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("isTextEntry", () => {
  const input = (type?: string) => {
    const el = document.createElement("input");
    if (type) el.setAttribute("type", type);
    return el;
  };

  it("is false for the inputs you cannot type into", () => {
    for (const type of ["checkbox", "radio", "button", "submit", "reset", "file", "color", "range"]) {
      expect(isTextEntry(input(type)), type).toBe(false);
    }
  });

  it("is true for the ones you can", () => {
    for (const type of ["text", "search", "email", "url", "tel", "password", "number", "date", "time"]) {
      expect(isTextEntry(input(type)), type).toBe(true);
    }
  });

  it("treats an input with no type as text, which is what the browser does", () => {
    expect(isTextEntry(input())).toBe(true);
  });

  it("covers textarea, select and contenteditable", () => {
    expect(isTextEntry(document.createElement("textarea"))).toBe(true);
    // A select takes letters too: typing jumps to the matching option, and a
    // shortcut would steal that.
    expect(isTextEntry(document.createElement("select"))).toBe(true);
    const div = document.createElement("div");
    div.contentEditable = "true";
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(isTextEntry(div)).toBe(true);
  });

  it("is false for a button and for nothing at all", () => {
    expect(isTextEntry(document.createElement("button"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe("shortcuts with a checkbox focused", () => {
  it("still fire — the reported bug", () => {
    const handler = vi.fn();
    pop = keyboard.pushScope("test", [{ keys: "e", description: "Archive", group: "Mail", handler }]);

    const box = document.createElement("input");
    box.type = "checkbox";
    document.body.appendChild(box);
    box.focus();

    pressFrom(box, "e");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still do not fire from a text field", () => {
    const handler = vi.fn();
    pop = keyboard.pushScope("test", [{ keys: "e", description: "Archive", group: "Mail", handler }]);

    const field = document.createElement("input");
    field.type = "search";
    document.body.appendChild(field);
    field.focus();

    pressFrom(field, "e");
    expect(handler).not.toHaveBeenCalled();
  });
});
