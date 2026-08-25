import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuleDialog } from "../RuleDialog";
import { newRule } from "@/lib/sieve";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Choosing "Other header…" used to put the header-name box in the column the
 * comparator lived in, so the comparator vanished: whatever it happened to be
 * (contains) was what you were stuck with. Both belong in the row.
 */
describe("RuleDialog custom headers", () => {
  let host: HTMLDivElement;
  let root: Root;

  /** The condition row's own selects: [field, comparator]. */
  const selects = () => Array.from(document.querySelectorAll<HTMLSelectElement>(".rule-row:not(.actions) select"));
  const find = (sel: string) => document.querySelector(sel);
  const pick = (el: HTMLSelectElement, value: string) => act(() => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = () => act(() => {
    root.render(<RuleDialog rule={newRule({ id: "r1" })} onClose={() => undefined} onSave={() => undefined} />);
  });

  it("keeps the comparator when a header is typed by hand", () => {
    render();
    // [field, comparator] — the rule starts on "from contains".
    expect(selects()).toHaveLength(2);
    pick(selects()[0]!, "__custom__");

    const header = find('input[aria-label="Header name"]') as HTMLInputElement | null;
    expect(header).not.toBeNull();
    expect(header!.value).toBe("");
    const ops = selects()[1]!;
    expect(ops.value).toBe("contains");
    expect(Array.from(ops.options).map((o) => o.value)).toContain("matches");

    pick(ops, "matches");
    expect(selects()[1]!.value).toBe("matches");
    // The header box is still there, and still has a column of its own.
    expect(find('input[aria-label="Header name"]')).not.toBeNull();
    expect(find(".rule-row.named-header")).not.toBeNull();
  });

  it("leaves a listed header alone", () => {
    render();
    expect(find('input[aria-label="Header name"]')).toBeNull();
    expect(find(".rule-row.named-header")).toBeNull();
    pick(selects()[1]!, "is");
    expect(selects()[1]!.value).toBe("is");
  });
});
