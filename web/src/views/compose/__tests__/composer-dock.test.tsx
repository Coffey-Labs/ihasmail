import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompose, type Draft } from "@/store/compose";
import { ComposerDock } from "../ComposerDock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The question is which composers the dock puts on screen, not what is inside
// them, so each composer is a bare marker carrying the state it was given.
vi.mock("../Composer", () => ({
  Composer: ({ draft }: { draft: Draft }) => (
    <div className={`composer ${draft.maximized ? "maximized" : ""} ${draft.minimized ? "minimized" : ""}`} data-key={draft.key} />
  ),
}));

/* jsdom has no matchMedia; each test says which side of the 768px breakpoint it stands at. */
function setWidth(px: number) {
  window.matchMedia = ((q: string) => ({
    matches: /max-width:\s*(\d+)px/.test(q) ? px <= Number(RegExp.$1) : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

const draft = (key: string, init: Partial<Draft> = {}) => ({ key, minimized: false, maximized: false, ...init }) as Draft;

describe("ComposerDock with a full-screen composer", () => {
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
    useCompose.setState({ drafts: [], activeKey: null });
  });

  const render = (drafts: Draft[], activeKey: string) => {
    useCompose.setState({ drafts, activeKey });
    act(() => root.render(<ComposerDock />));
  };
  const dock = () => host.querySelector(".composer-dock")!;

  it("marks the dock so the other composers are hidden behind it", () => {
    setWidth(1300);
    render([draft("a"), draft("b", { maximized: true }), draft("c")], "b");
    expect(dock().classList.contains("has-maximized")).toBe(true);
    // Every composer stays mounted: the hiding is the stylesheet's, so nothing being typed elsewhere is lost.
    expect(host.querySelectorAll(".composer").length).toBe(3);
  });

  it("leaves the dock alone while nobody is full screen", () => {
    setWidth(1300);
    render([draft("a"), draft("b")], "b");
    expect(dock().classList.contains("has-maximized")).toBe(false);
  });

  it("does not count a full-screen composer that has since been minimised", () => {
    setWidth(1300);
    render([draft("a"), draft("b", { maximized: true, minimized: true })], "a");
    expect(dock().classList.contains("has-maximized")).toBe(false);
  });

  it("is not a phone concern: there the active composer is already the only one open", () => {
    setWidth(400);
    render([draft("a"), draft("b", { maximized: true })], "b");
    expect(dock().classList.contains("has-maximized")).toBe(false);
  });
});
