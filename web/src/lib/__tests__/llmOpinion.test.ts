import { describe, expect, it } from "vitest";
import { LLM_HEADER_PROP, llmOpinion, parseLlmOpinion } from "@/lib/llmOpinion";

/*
 * The header as Stalwart's spam filter writes it (analysis/score.rs):
 * `X-Spam-LLM: <category> (<explanation>)`, folded at 78 columns.
 */
describe("parseLlmOpinion", () => {
  it("reads category and explanation", () => {
    expect(parseLlmOpinion("Unsolicited (Promotes a product the reader never asked about)")).toEqual({
      tag: "Unsolicited",
      category: "Unsolicited",
      confidence: null,
      explanation: "Promotes a product the reader never asked about",
    });
  });

  it("reads a category with no explanation", () => {
    expect(parseLlmOpinion("Legitimate")).toEqual({ tag: "Legitimate", category: "Legitimate", confidence: null, explanation: null });
  });

  it("makes a category in capitals or with underscores readable", () => {
    expect(parseLlmOpinion("COLD_OUTREACH (Sales email)")?.category).toBe("Cold outreach");
    expect(parseLlmOpinion("HARMFUL")?.category).toBe("Harmful");
    expect(parseLlmOpinion("Phishing-attempt")?.category).toBe("Phishing-attempt");
  });

  it("reads a tag in the spam filter's form, with its confidence", () => {
    const o = parseLlmOpinion("LLM_COLD_OUTREACH_MEDIUM (Sales email)");
    expect(o?.category).toBe("Cold outreach");
    expect(o?.confidence).toBe("Medium");
    // An unknown last word is part of the category, not a confidence.
    expect(parseLlmOpinion("LLM_COLD_OUTREACH")?.category).toBe("Cold outreach");
    expect(parseLlmOpinion("LLM_COLD_OUTREACH")?.confidence).toBeNull();
  });

  it("unfolds a folded header and keeps inner parentheses", () => {
    const o = parseLlmOpinion("Harmful (Asks for a password\r\n  (urgently) via a link)");
    expect(o?.explanation).toBe("Asks for a password (urgently) via a link");
  });

  it("returns null for anything that isn't the server's form", () => {
    for (const raw of [null, undefined, "", "   ", "Yes, score=6.7", "LLM_", "X LLM_SPAM", "Spam because reasons"]) {
      expect(parseLlmOpinion(raw), String(raw)).toBeNull();
    }
  });

  it("reads the JMAP property a full message carries", () => {
    expect(llmOpinion({ [LLM_HEADER_PROP]: "Legitimate (Order confirmation)" })?.category).toBe("Legitimate");
    expect(llmOpinion({})).toBeNull();
  });
});
