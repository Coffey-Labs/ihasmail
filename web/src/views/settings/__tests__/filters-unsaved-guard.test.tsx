import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FiltersSettings } from "../FiltersSettings";
import { ConfirmHost } from "@/ui/dialog";
import { useSieve } from "@/store/sieve";
import { hasUnsavedChanges } from "@/lib/unsavedChanges";
import { newRule, rulesToSieve } from "@/lib/sieve";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Everything here is a click, and a click can answer a dialog. Answering one
 * resolves a promise that another promise is waiting on -- discard, then
 * continue, then navigate -- so settle the queue rather than a single tick of
 * it, or the assertion runs a link in the chain too early.
 */
const click = async (el: Element | null | undefined) => {
  expect(el, "nothing to click").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

describe("leaving the filter editors with unsaved changes", () => {
  let host: HTMLDivElement;
  let root: Root;
  let live = false;
  const unmount = () => { if (live) { act(() => root.unmount()); live = false; } };
  /**
   * The dialog queue is a module-level store, so a question nobody answered
   * outlives the test that asked it and is the one the next test finds on
   * screen. Answer whatever is still up -- by dismissing, which changes
   * nothing -- while the host that renders it is still mounted.
   */
  const drain = async () => {
    for (let i = 0; i < 5 && document.querySelector(".dialog"); i++) {
      await click(document.querySelector(".dialog-foot .btn"));
    }
  };

  const byText = (sel: string, text: string) => Array.from(document.querySelectorAll(sel)).find((e) => e.textContent?.includes(text));
  const tab = (label: string) => byText(".view-switch button", label);
  const dialogChoice = (label: string) => byText(".dialog-choice", label);
  const onScriptsTab = () => Boolean(document.body.textContent?.includes("manage raw Sieve scripts"));
  /** The first rule's on/off switch: flipping it is the smallest possible edit. */
  const firstToggle = () => document.querySelector(".rule-card .switch");

  beforeEach(() => {
    const rules = ["Newsletters", "From the boss"].map((name, i) => newRule({ id: `r${i}`, name }));
    useSieve.setState({
      accountId: "a", available: true, loading: false, error: null,
      scripts: [{ id: "s1", name: "ihasmail", blobId: "b1", isActive: true }],
      contents: { s1: rulesToSieve(rules) },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<><FiltersSettings /><ConfirmHost /></>));
    live = true;
  });
  afterEach(async () => { await drain(); unmount(); host.remove(); });

  it("has nothing to ask about until something is edited", async () => {
    expect(hasUnsavedChanges()).toBe(false);
    await click(tab("Scripts"));
    expect(onScriptsTab()).toBe(true);
  });

  it("says so on screen as soon as there is unsaved work", async () => {
    expect(document.querySelector(".save-bar .unsaved")).toBeNull();
    await click(firstToggle());
    expect(hasUnsavedChanges()).toBe(true);
    expect(document.querySelector(".save-bar .unsaved")).not.toBeNull();
  });

  it("asks before a tab switch throws the edits away", async () => {
    await click(firstToggle());
    await click(tab("Scripts"));
    // Still here, and still asking.
    expect(onScriptsTab()).toBe(false);
    expect(dialogChoice("Discard")).toBeTruthy();
  });

  it("stays put, edits intact, when the question is dismissed", async () => {
    await click(firstToggle());
    await click(tab("Scripts"));
    await click(document.querySelector(".dialog-foot .btn"));
    expect(document.querySelector(".dialog")).toBeNull();
    expect(onScriptsTab()).toBe(false);
    expect(hasUnsavedChanges()).toBe(true);
    expect(document.querySelector(".save-bar .unsaved")).not.toBeNull();
  });

  it("goes on to the other tab once the edits are discarded", async () => {
    await click(firstToggle());
    await click(tab("Scripts"));
    await click(dialogChoice("Discard"));
    expect(onScriptsTab()).toBe(true);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it("registers nothing once the editor is gone", async () => {
    await click(firstToggle());
    expect(hasUnsavedChanges()).toBe(true);
    unmount();
    expect(hasUnsavedChanges()).toBe(false);
  });
});
