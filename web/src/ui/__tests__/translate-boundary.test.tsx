import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranslateBoundary, isDomMutationError } from "../TranslateBoundary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Chrome's translator wraps text nodes in <font> behind React's back, so the
 * next update calls removeChild against a parent whose children have moved and
 * the DOM throws. React unmounts the whole tree over it
 * (facebook/react#11538). The boundary's job is to put the subtree back
 * instead, and to leave everything that is not that alone.
 */
describe("recognising the translator's damage", () => {
  it("knows the DOM errors Chrome's rewriting produces", () => {
    const notFound = new Error("Failed to execute 'removeChild' on 'Node'");
    notFound.name = "NotFoundError";
    expect(isDomMutationError(notFound)).toBe(true);
    expect(isDomMutationError(new Error("The node before which the new node is to be inserted is not a child of this node"))).toBe(true);
  });

  it("matches on the error name as well as the message", () => {
    // The message is browser-specific and localised. Matching only on English
    // text would be a translation bug that only works in English.
    const localised = new Error("Знайдений вузол не є дочірнім");
    localised.name = "NotFoundError";
    expect(isDomMutationError(localised)).toBe(true);
  });

  it("does not claim an ordinary bug", () => {
    expect(isDomMutationError(new TypeError("x is not a function"))).toBe(false);
    expect(isDomMutationError("a string")).toBe(false);
  });
});

describe("the boundary", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  /*
   * Throws on its first renders, then succeeds — the shape of a pane whose
   * DOM was rewritten and then remounted clean.
   *
   * It has to keep throwing past the first attempt. React answers an error in
   * a concurrent render by retrying the whole root synchronously, and a
   * component that throws exactly once succeeds on that retry and never
   * reaches the boundary at all — which looks like the boundary not working
   * and is really the test not reproducing anything.
   */
  function Flaky({ fails }: { fails: { left: number } }) {
    if (fails.left > 0) {
      fails.left -= 1;
      const err = new Error("Failed to execute 'removeChild' on 'Node'");
      err.name = "NotFoundError";
      throw err;
    }
    return <p>content</p>;
  }

  it("remounts the subtree instead of losing it", () => {
    const fails = { left: 2 };   // the concurrent attempt and the sync retry
    const onRecover = vi.fn();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => {
      root.render(<TranslateBoundary onRecover={onRecover}><Flaky fails={fails} /></TranslateBoundary>);
    });
    expect(host.textContent).toBe("content");
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it("logs the recovery as information, not as an error", () => {
    // A reader translating the page is expected and recovered from. Logging it
    // as an error would file a bug report in every console-reading reporter,
    // every time, for behaviour that worked.
    const fails = { left: 2 };
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => {
      root.render(<TranslateBoundary><Flaky fails={fails} /></TranslateBoundary>);
    });
    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0]?.[0])).toContain("recovered from a DOM error");
    /*
     * React logs every error a boundary catches to console.error itself, in
     * development, and that is not ours to suppress. What matters is that
     * ihasmail does not add one of its own on top: the recovery is reported
     * as information, so a console-reading error reporter sees React's dev
     * noise and nothing from us claiming a failure.
     */
    const ours = error.mock.calls.filter((c) => String(c[0]).includes("[ihasmail]"));
    expect(ours).toEqual([]);
  });

  it("lets a real bug through rather than swallowing it", () => {
    function Broken(): never {
      throw new TypeError("genuinely broken");
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => {
      act(() => {
        root.render(<TranslateBoundary><Broken /></TranslateBoundary>);
      });
    }).toThrow(/genuinely broken/);
  });
});
