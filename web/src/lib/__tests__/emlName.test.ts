import { describe, expect, it } from "vitest";
import { emlFilename, sanitizeFilename } from "@/lib/emlName";

describe("emlFilename", () => {
  it("keeps an ordinary subject, with spaces as underscores", () => {
    expect(emlFilename("Quarterly report")).toBe("Quarterly_report.eml");
  });

  it("keeps letters from any script, which the ASCII rule threw away", () => {
    // The whole point: none of these may come out as a row of underscores.
    expect(emlFilename("Квартальный отчёт")).toBe("Квартальный_отчёт.eml");
    expect(emlFilename("四半期報告")).toBe("四半期報告.eml");
    expect(emlFilename("Rapport trimestriel été")).toBe("Rapport_trimestriel_été.eml");
  });

  it("keeps the punctuation that is fine in a filename", () => {
    expect(emlFilename("Re- budget (v3) [final]")).toBe("Re-_budget_(v3)_[final].eml");
  });

  it("drops path separators and the characters Windows reserves", () => {
    expect(emlFilename("a/b\\c:d*e?f\"g<h>i|j")).toBe("abcdefghij.eml");
  });

  it("drops control characters", () => {
    expect(emlFilename("a\u0007b\u0000c")).toBe("abc.eml");
    expect(emlFilename("a\u007fb")).toBe("ab.eml");
  });

  it("falls back when there is no subject, or nothing survives", () => {
    expect(emlFilename("")).toBe("message.eml");
    expect(emlFilename(null)).toBe("message.eml");
    expect(emlFilename(undefined)).toBe("message.eml");
    expect(emlFilename("///")).toBe("message.eml");
    expect(emlFilename("   ")).toBe("message.eml");
  });

  it("does not end in a dot or a space, which Windows refuses", () => {
    expect(emlFilename("Report.")).toBe("Report.eml");
    expect(emlFilename("Report ")).toBe("Report.eml");
    expect(emlFilename("...Report...")).toBe("Report.eml");
  });

  it("does not start with a dot, which would hide the file on Unix", () => {
    expect(emlFilename(".hidden")).toBe("hidden.eml");
  });

  it("caps the length so it survives a filesystem limit", () => {
    const name = emlFilename("x".repeat(500));
    expect(name).toBe(`${"x".repeat(80)}.eml`);
  });

  it("exposes the stem on its own", () => {
    expect(sanitizeFilename("Quarterly report")).toBe("Quarterly_report");
  });
});
