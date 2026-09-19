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

const QUOTE_HTML = '<div class="ihm-quote"><br><div>On Friday, Ann wrote:</div><blockquote><p>Look at <b>this</b></p></blockquote></div>';
const QUOTE_TEXT = "\n\nOn Friday, Ann wrote:\n> Look at this";

const REPLY: Partial<Draft> = {
  key: "d1", replyMode: "reply", subject: "Re: Numbers",
  format: "text", text: QUOTE_TEXT, html: `<div><br></div>${QUOTE_HTML}`,
  quoteHtml: QUOTE_HTML, quoteText: QUOTE_TEXT,
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

  /*
   * The message being quoted was prepared in both formats when the reply
   * opened. Switching used to convert the plain-text body it had, handing
   * back a flattened copy -- "> Look at this" -- of markup that still
   * existed untouched on the draft.
   */
  it("restores the original message, rather than converting the flattened quote", () => {
    act(() => button("Switch to rich text").click());
    act(() => root.render(<Composer draft={draft()} />));
    expect(draft().html).toContain("<b>this</b>");
    expect(draft().html).toContain("<blockquote>");
    expect(draft().html).not.toContain("&gt; Look at this");
  });

  it("keeps what the author typed above the quote", () => {
    useCompose.getState().update("d1", { text: `Thanks, that helps.${QUOTE_TEXT}` });
    act(() => root.render(<Composer draft={draft()} />));
    act(() => button("Switch to rich text").click());
    act(() => root.render(<Composer draft={draft()} />));
    expect(draft().html).toContain("Thanks, that helps.");
    expect(draft().html).toContain("<b>this</b>");
    // Once only: the typed reply must not arrive with the quote doubled.
    expect(draft().html.match(/On Friday, Ann wrote:/g)).toHaveLength(1);
  });

  it("goes back to plain text with the prepared quote, not a re-flattened one", () => {
    // A rich draft answering a plain-text message: the offer runs the other way.
    act(() => {
      useCompose.getState().update("d1", { format: "html", html: `<div>Thanks.</div>${QUOTE_HTML}`, formatOffer: "text" });
    });
    act(() => root.render(<Composer draft={draft()} />));
    act(() => button("Switch to plain text").click());
    act(() => root.render(<Composer draft={draft()} />));
    expect(draft().format).toBe("text");
    expect(draft().text).toContain("Thanks.");
    // The prepared plain-text quote, not HTML run through a converter.
    expect(draft().text.endsWith(QUOTE_TEXT)).toBe(true);
    expect(draft().text).not.toContain("<blockquote>");
  });

  it("dismisses without changing the format", () => {
    act(() => button("Dismiss").click());
    act(() => root.render(<Composer draft={draft()} />));
    expect(draft().format).toBe("text");
    expect(bar()).toBeNull();
  });
});
