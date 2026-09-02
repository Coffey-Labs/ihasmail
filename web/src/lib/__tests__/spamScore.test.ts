import { describe, expect, it } from "vitest";
import { spamReport } from "@/lib/spamScore";

const sa = (v: string) => spamReport({ "header:X-Spam-Status:asText": v });
const rs = (v: string) => spamReport({ "header:X-Spamd-Result:asText": v });

describe("spamReport, SpamAssassin-shaped headers", () => {
  it("reads the verdict, score, threshold and tests", () => {
    const r = sa("Yes, score=6.7 required=5.0 tests=[BAYES_99=3.5, HTML_MESSAGE=0.001, URIBL=2.2] autolearn=no");
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe("spam");
    expect(r!.score).toBe(6.7);
    expect(r!.threshold).toBe(5);
    expect(r!.source).toBe("spamassassin");
    // Biggest mover first, so the reason it was scored reads off the top.
    expect(r!.rules.map((x) => x.name)).toEqual(["BAYES_99", "URIBL", "HTML_MESSAGE"]);
  });

  it("reads a negative score and a clean verdict", () => {
    const r = sa("No, score=-2.6 required=5.0 tests=[BAYES_00=-1.9, DKIM_VALID=-0.7]");
    expect(r!.verdict).toBe("clean");
    expect(r!.score).toBe(-2.6);
    expect(r!.rules[0]).toEqual({ name: "BAYES_00", score: -1.9 });
  });

  it("survives a folded header, which is how they arrive", () => {
    const r = sa("Yes, score=6.7\n\trequired=5.0 tests=[BAYES_99=3.5,\n\tURIBL=2.2]");
    expect(r!.score).toBe(6.7);
    expect(r!.rules).toHaveLength(2);
  });

  it("keeps a verdict that states no score, and a score that states no verdict", () => {
    expect(sa("Yes")!.verdict).toBe("spam");
    expect(sa("Yes")!.score).toBeNull();
    const scoreOnly = sa("score=1.2 required=5.0");
    expect(scoreOnly!.verdict).toBeNull();
    expect(scoreOnly!.score).toBe(1.2);
  });

  it("says nothing when there is nothing it understands", () => {
    expect(sa("")).toBeNull();
    expect(sa("something else entirely")).toBeNull();
    expect(spamReport({})).toBeNull();
  });

  it("drops a malformed test rather than scoring it as zero", () => {
    const r = sa("Yes, score=3.0 tests=[GOOD=1.0, BROKEN=, =2.0, ALSO_GOOD=2.0]");
    expect(r!.rules.map((x) => x.name)).toEqual(["ALSO_GOOD", "GOOD"]);
  });
});

describe("spamReport, Rspamd", () => {
  it("reads the action, score, threshold and rules with their notes", () => {
    const r = rs("default: False [1.20 / 15.00]; MIME_GOOD(-0.10)[text/plain]; DKIM_ALLOW(-0.20)[example.com]; SUBJ_CAPS(2.00)[]");
    expect(r!.verdict).toBe("clean");
    expect(r!.score).toBe(1.2);
    expect(r!.threshold).toBe(15);
    expect(r!.source).toBe("rspamd");
    expect(r!.rules[0]).toEqual({ name: "SUBJ_CAPS", score: 2 });
    expect(r!.rules.find((x) => x.name === "DKIM_ALLOW")?.detail).toBe("example.com");
    // An empty bracket is not a note.
    expect(r!.rules[0]!.detail).toBeUndefined();
  });

  it("treats the acting verdicts as spam and False as clean", () => {
    expect(rs("default: True [20.00 / 15.00];")!.verdict).toBe("spam");
    expect(rs("default: reject [20.00 / 15.00];")!.verdict).toBe("spam");
    expect(rs("default: add_header [16.00 / 15.00];")!.verdict).toBe("spam");
    expect(rs("default: False [1.00 / 15.00];")!.verdict).toBe("clean");
  });

  it("declines to call greylisting a verdict about the message", () => {
    const r = rs("default: greylist [8.00 / 15.00];");
    expect(r!.verdict).toBeNull();
    expect(r!.score).toBe(8);
  });

  it("says nothing for a header it cannot read", () => {
    expect(rs("")).toBeNull();
    expect(rs("default: False")).toBeNull();
  });
});

describe("spamReport, precedence and fallback", () => {
  it("prefers the SpamAssassin set, which is what Stalwart's own filter writes", () => {
    const r = spamReport({
      "header:X-Spam-Status:asText": "Yes, score=6.7 required=5.0",
      "header:X-Spamd-Result:asText": "default: False [1.20 / 15.00];",
    });
    expect(r!.source).toBe("spamassassin");
    expect(r!.verdict).toBe("spam");
  });

  it("falls back to a bare score, with no threshold to read it against", () => {
    const r = spamReport({ "header:X-Spam-Score:asText": "+4.1" });
    expect(r!.score).toBe(4.1);
    expect(r!.threshold).toBeNull();
    expect(r!.verdict).toBeNull();
    expect(r!.rules).toEqual([]);
  });

  it("does not invent a verdict from score against threshold", () => {
    // Above the threshold, but the filter did not say "Yes" -- so neither do we.
    const r = sa("score=9.9 required=5.0 tests=[X=9.9]");
    expect(r!.verdict).toBeNull();
  });
});
