import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Composer } from "../Composer";
import { useCompose, type Draft } from "@/store/compose";
import { useMail } from "@/store/mail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The bar the composer shows when the draft's format doesn't match the message
 * it is answering (#407). A store test can say the offer was made; only the
 * component can say that pressing it converts the body and puts the bar away.
 */

window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const REPLY: Partial<Draft> = {
  key: "d1", replyMode: "reply", subject: "Re: Numbers",
  format: "text", text: "\n\nOn Friday, Ann wrote:\n> hi", html: "<div><br></div><div class=\"ihm-quote\">hi</div>",
  formatOffer: "html",
};

describe("the format offer in the composer", () => {
  let host: HTMLDivElement;
  let root: Root;
  const bar = () => document.querySelector(".composer-notice");
  const draft = () => useCompose.getState().drafts[0]!;
  const button = (label: string) => Array.from(document.querySelectorAll<HTMLElement>(".composer-notice button")).find((b) => b.textContent === label || b.getAttribute("aria-label") === label)!;

  beforeEach(() => {
    useMail.setState({ accountId: "a1", identities: [] as never });
    useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
    const key = useCompose.getState().open();
    useCompose.getState().update(key, REPLY);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<Composer draft={draft()} />));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("offers the message's own format, and says which it is", () => {
    expect(bar()?.textContent).toContain("This message is rich text");
    expect(button("Switch to rich text")).toBeTruthy();
  });

  it("switches this draft and puts the bar away", () => {
    act(() => button("Switch to rich text").click());
    act(() => root.render(<Composer draft={draft()} />));
    expect(draft().format).toBe("html");
    // The quoted reply came across, rather than the editor opening empty.
    expect(draft().html).toContain("Ann wrote");
    expect(bar()).toBeNull();
  });

  it("dismisses without changing the format", () => {
    act(() => button("Dismiss").click());
    act(() => root.render(<Composer draft={draft()} />));
    expect(draft().format).toBe("text");
    expect(bar()).toBeNull();
  });
});
