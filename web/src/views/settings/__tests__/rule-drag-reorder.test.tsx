import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FiltersSettings } from "../FiltersSettings";
import { useSieve } from "@/store/sieve";
import { newRule, rulesToSieve } from "@/lib/sieve";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no DataTransfer, and no layout — both are faked just enough. */
function dataTransfer() {
  const data: Record<string, string> = {};
  return {
    types: [] as string[],
    effectAllowed: "",
    dropEffect: "",
    setData(k: string, v: string) { data[k] = v; this.types.push(k); },
    getData(k: string) { return data[k] ?? ""; },
  };
}
function fire(el: Element, type: string, dt: ReturnType<typeof dataTransfer>, clientY = 0) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  Object.defineProperty(ev, "clientY", { value: clientY });
  act(() => { el.dispatchEvent(ev); });
}
/** Cards have no size in jsdom, so any positive clientY counts as the lower half. */
const LOWER = 1;
const UPPER = 0;

describe("reordering rules by dragging", () => {
  let host: HTMLDivElement;
  let root: Root;
  const cards = () => Array.from(document.querySelectorAll(".rule-card"));
  const names = () => cards().map((c) => c.querySelector('div[style*="font-weight"]')?.textContent);
  const press = (i: number) => act(() => { cards()[i]!.querySelector(".drag-handle")!.dispatchEvent(new Event("pointerdown", { bubbles: true })); });

  beforeEach(() => {
    const rules = ["Newsletters", "From the boss", "Receipts"].map((name, i) => newRule({ id: `r${i}`, name }));
    useSieve.setState({
      accountId: "a", available: true, loading: false, error: null,
      scripts: [{ id: "s1", name: "ihasmail", blobId: "b1", isActive: true }],
      contents: { s1: rulesToSieve(rules) },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<FiltersSettings />));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("arms dragging only from the handle of the rule pressed", () => {
    expect(cards()).toHaveLength(3);
    expect(cards().map((c) => c.getAttribute("draggable"))).toEqual(["false", "false", "false"]);
    press(1);
    expect(cards().map((c) => c.getAttribute("draggable"))).toEqual(["false", "true", "false"]);
  });

  it("drops a rule below the card it was dragged onto", () => {
    press(0);
    const dt = dataTransfer();
    fire(cards()[0]!, "dragstart", dt);
    expect(cards()[0]!.className).toContain("dragging");
    fire(cards()[2]!, "dragover", dt, LOWER);
    expect(cards()[2]!.className).toContain("drop-below");
    fire(cards()[2]!, "drop", dt, LOWER);
    expect(names()).toEqual(["From the boss", "Receipts", "Newsletters"]);
    expect(cards().every((c) => !/dragging|drop-(above|below)/.test(c.className))).toBe(true);
  });

  it("drops a rule above the card when the pointer is in its top half", () => {
    press(2);
    const dt = dataTransfer();
    fire(cards()[2]!, "dragstart", dt);
    fire(cards()[0]!, "dragover", dt, UPPER);
    expect(cards()[0]!.className).toContain("drop-above");
    fire(cards()[0]!, "drop", dt, UPPER);
    expect(names()).toEqual(["Receipts", "Newsletters", "From the boss"]);
  });

  it("draws no drop line on the rule being dragged, even before React re-renders", () => {
    press(1);
    const dt = dataTransfer();
    // dragstart and dragover back to back: the guard cannot wait for a render.
    fire(cards()[1]!, "dragstart", dt);
    fire(cards()[1]!, "dragover", dt, LOWER);
    expect(cards().some((c) => /drop-(above|below)/.test(c.className))).toBe(false);
    fire(cards()[1]!, "drop", dt, LOWER);
    expect(names()).toEqual(["Newsletters", "From the boss", "Receipts"]);
  });

  it("ignores a drag that is not a rule", () => {
    const dt = dataTransfer();
    dt.setData("text/plain", "hello");
    fire(cards()[1]!, "dragover", dt, LOWER);
    expect(cards().some((c) => /drop-(above|below)/.test(c.className))).toBe(false);
  });
});
