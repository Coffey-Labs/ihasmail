import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlmOpinionBanner, LlmOpinionDetail, llmBannerOpinion } from "../LlmOpinion";
import { parseLlmOpinion, type LlmOpinion } from "@/lib/llmOpinion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The framing is the feature: the model's opinion is always one signal among
 * several, never presented as why a message is where it is, and its
 * explanation is model output, so it must never be rendered as markup.
 */
const opinion = (raw: string) => parseLlmOpinion(raw) as LlmOpinion;

describe("the language model's opinion", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async (node: React.ReactNode) => {
    await act(async () => {
      root.render(node);
    });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("shows category and explanation, as one signal of several", async () => {
    await render(<LlmOpinionDetail opinion={opinion("Unsolicited (Sells something unasked)")} />);
    expect(host.textContent).toContain("Unsolicited");
    expect(host.textContent).toContain("Sells something unasked");
    expect(host.textContent).toContain("One of several signals the spam filter weighed");
  });

  it("renders the explanation as text, never markup", async () => {
    await render(<LlmOpinionDetail opinion={opinion('Harmful (<img src=x onerror="alert(1)"> <b>bold</b>)')} />);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("b")).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("shows a confidence where the header carried one", async () => {
    await render(<LlmOpinionDetail opinion={opinion("LLM_UNSOLICITED_HIGH (Sells something unasked)")} />);
    expect(host.textContent).toContain("High");
  });

  it("leaves out what the header didn't carry", async () => {
    await render(<LlmOpinionDetail opinion={opinion("Legitimate")} />);
    expect(host.querySelector(".llm-explanation")).toBeNull();
    expect(host.textContent).not.toContain("·");
  });

  it("banners a message in Junk with the same framing", async () => {
    await render(<LlmOpinionBanner opinion={opinion("Unsolicited (Bulk newsletter)")} />);
    expect(host.textContent).toContain("Language model's opinion");
    expect(host.textContent).toContain("Unsolicited");
    expect(host.textContent).toContain("Bulk newsletter");
    expect(host.textContent).toContain("One of several signals the spam filter weighed");
  });

  it("banners only a message that's in Junk and carries an opinion", () => {
    const o = opinion("Unsolicited");
    expect(llmBannerOpinion(o, { junk1: true }, "junk1")).toBe(o);
    expect(llmBannerOpinion(o, { inbox1: true }, "junk1")).toBeNull();
    expect(llmBannerOpinion(o, { junk1: true }, null)).toBeNull();
    expect(llmBannerOpinion(null, { junk1: true }, "junk1")).toBeNull();
  });
});
