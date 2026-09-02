import { describe, expect, it } from "vitest";
import { fillPlaceholders, PLACEHOLDER_NAMES, type PlaceholderContext } from "@/lib/templatePlaceholders";

const AT = new Date("2026-03-04T15:07:00Z");

function ctx(over: Partial<PlaceholderContext> = {}): PlaceholderContext {
  return {
    to: [{ name: "Ada Lovelace", email: "ada@example.com" }],
    from: { name: "Grace Hopper", email: "grace@example.com" },
    subject: "Quarterly report",
    now: AT,
    ...over,
  };
}

describe("fillPlaceholders", () => {
  it("fills the names it knows", () => {
    expect(fillPlaceholders("Hi {{recipientFirstName}},", ctx(), { html: true })).toBe("Hi Ada,");
    expect(fillPlaceholders("{{recipientName}} <{{recipientEmail}}>", ctx(), { html: false })).toBe("Ada Lovelace <ada@example.com>");
    expect(fillPlaceholders("-- {{myName}}", ctx(), { html: true })).toBe("-- Grace Hopper");
    expect(fillPlaceholders("Re: {{subject}}", ctx(), { html: false })).toBe("Re: Quarterly report");
  });

  it("tolerates spaces inside the braces but not a different case", () => {
    expect(fillPlaceholders("{{ myEmail }}", ctx(), { html: false })).toBe("grace@example.com");
    expect(fillPlaceholders("{{MyEmail}}", ctx(), { html: false })).toBe("{{MyEmail}}");
  });

  it("leaves a placeholder it cannot answer exactly as written", () => {
    // The case the design is about: a template inserted before the message is
    // addressed. "Hi ," would be wrong; "Hi {{recipientFirstName}}," is unfinished.
    const unaddressed = ctx({ to: [] });
    expect(fillPlaceholders("Hi {{recipientFirstName}},", unaddressed, { html: true })).toBe("Hi {{recipientFirstName}},");
    expect(fillPlaceholders("{{recipientEmail}}", unaddressed, { html: false })).toBe("{{recipientEmail}}");
    expect(fillPlaceholders("{{myName}}", ctx({ from: null }), { html: false })).toBe("{{myName}}");
  });

  it("leaves a name it does not know alone rather than eating it", () => {
    expect(fillPlaceholders("{{nonsense}} {{}} {{ }}", ctx(), { html: true })).toBe("{{nonsense}} {{}} {{ }}");
  });

  it("falls back to the local part when a recipient has no name", () => {
    const c = ctx({ to: [{ name: null, email: "ada.lovelace@example.com" }] });
    expect(fillPlaceholders("{{recipientName}}", c, { html: false })).toBe("ada.lovelace");
    expect(fillPlaceholders("{{recipientFirstName}}", c, { html: false })).toBe("ada.lovelace");
  });

  it("escapes a substituted value on the way into HTML, and not into a subject", () => {
    const c = ctx({ to: [{ name: 'Ada <script>alert("x")</script>', email: "ada@example.com" }] });
    expect(fillPlaceholders("{{recipientName}}", c, { html: true })).not.toContain("<script>");
    expect(fillPlaceholders("{{recipientName}}", c, { html: true })).toContain("&lt;script&gt;");
    expect(fillPlaceholders("{{recipientName}}", c, { html: false })).toContain("<script>");
  });

  it("repeats a placeholder as many times as it appears", () => {
    expect(fillPlaceholders("{{recipientFirstName}} {{recipientFirstName}}", ctx(), { html: true })).toBe("Ada Ada");
  });

  it("answers date and time from the injected clock", () => {
    const date = fillPlaceholders("{{date}}", ctx(), { html: false });
    const time = fillPlaceholders("{{time}}", ctx(), { html: false });
    expect(date).not.toBe("{{date}}");
    expect(date).toMatch(/2026/);
    expect(time).not.toBe("{{time}}");
    expect(time).toMatch(/\d/);
  });

  it("names every resolver in the list Settings shows", () => {
    expect(PLACEHOLDER_NAMES).toEqual([
      "recipientName",
      "recipientFirstName",
      "recipientEmail",
      "myName",
      "myEmail",
      "subject",
      "date",
      "time",
    ]);
  });
});
