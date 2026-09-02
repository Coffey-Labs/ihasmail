import { describe, expect, it } from "vitest";
import { appliesTo, comparatorsFor, isOptionalSort, MAX_LEVELS, withoutOptionalSorts } from "@/lib/listSort";

describe("comparatorsFor, presets", () => {
  it("puts newest first by default, and can reverse it", () => {
    expect(comparatorsFor("newest")).toEqual([{ property: "receivedAt", isAscending: false }]);
    // No tiebreak appended: receivedAt already *is* the tiebreaker, and adding
    // a contradictory second one after it would say nothing.
    expect(comparatorsFor("oldest")).toEqual([{ property: "receivedAt", isAscending: true }]);
  });

  it("sorts unread first as $seen ASCENDING, because false sorts before true", () => {
    // Getting this backwards puts exactly the mail you were looking for at the
    // bottom, which is why it is asserted rather than assumed.
    expect(comparatorsFor("unreadFirst")[0]).toEqual({ property: "hasKeyword", keyword: "$seen", isAscending: true });
  });

  it("sorts starred first as $flagged DESCENDING, which is the other way round", () => {
    expect(comparatorsFor("starredFirst")[0]).toEqual({ property: "hasKeyword", keyword: "$flagged", isAscending: false });
  });

  it("handles the plain field presets", () => {
    expect(comparatorsFor("largest")[0]).toEqual({ property: "size", isAscending: false });
    expect(comparatorsFor("sender")[0]).toEqual({ property: "from", isAscending: true });
    expect(comparatorsFor("subject")[0]).toEqual({ property: "subject", isAscending: true });
  });

  it("falls back to newest for a preset it does not know", () => {
    expect(comparatorsFor("nonsense" as never)).toEqual([{ property: "receivedAt", isAscending: false }]);
  });
});

describe("comparatorsFor, the tiebreak", () => {
  it("always ends newest-first, so a tie does not shuffle between loads", () => {
    for (const p of ["unreadFirst", "starredFirst", "largest", "sender", "subject"] as const) {
      const out = comparatorsFor(p);
      expect(out[out.length - 1]).toEqual({ property: "receivedAt", isAscending: false });
    }
  });

  it("does not add a second one when the sort already ends on receivedAt", () => {
    expect(comparatorsFor("newest")).toHaveLength(1);
    expect(comparatorsFor("oldest")).toHaveLength(1);
    expect(comparatorsFor("custom", [{ field: "date", descending: false }])).toHaveLength(1);
  });
});

describe("comparatorsFor, custom levels", () => {
  it("keeps the levels in the order given", () => {
    const out = comparatorsFor("custom", [
      { field: "starred", descending: true },
      { field: "unread", descending: true },
    ]);
    expect(out).toEqual([
      { property: "hasKeyword", keyword: "$flagged", isAscending: false },
      { property: "hasKeyword", keyword: "$seen", isAscending: true },
      { property: "receivedAt", isAscending: false },
    ]);
  });

  it("takes at most three, since past that nobody can predict the result", () => {
    const out = comparatorsFor("custom", [
      { field: "starred", descending: true },
      { field: "unread", descending: true },
      { field: "from", descending: false },
      { field: "size", descending: true },
    ]);
    expect(out.filter((c) => c.property === "size")).toEqual([]);
    expect(out).toHaveLength(MAX_LEVELS + 1); // three levels plus the tiebreak
  });

  it("drops a field repeated at two levels, which can only be a mistake", () => {
    const out = comparatorsFor("custom", [
      { field: "from", descending: false },
      { field: "from", descending: true },
    ]);
    expect(out).toEqual([
      { property: "from", isAscending: true },
      { property: "receivedAt", isAscending: false },
    ]);
  });

  it("falls back to the tiebreak alone when no levels were given", () => {
    expect(comparatorsFor("custom", [])).toEqual([{ property: "receivedAt", isAscending: false }]);
  });

  it("reverses a date level without losing the tiebreak", () => {
    const out = comparatorsFor("custom", [{ field: "sent", descending: false }]);
    expect(out).toEqual([
      { property: "sentAt", isAscending: true },
      { property: "receivedAt", isAscending: false },
    ]);
  });
});

describe("optional sorts, which a server is allowed to refuse", () => {
  it("recognises the keyword properties", () => {
    expect(isOptionalSort({ property: "hasKeyword", keyword: "$seen" })).toBe(true);
    expect(isOptionalSort({ property: "someInThreadHaveKeyword", keyword: "$flagged" })).toBe(true);
    expect(isOptionalSort({ property: "receivedAt" })).toBe(false);
    expect(isOptionalSort({ property: "size" })).toBe(false);
  });

  it("strips them, leaving something the server must accept", () => {
    const out = withoutOptionalSorts(comparatorsFor("custom", [
      { field: "unread", descending: true },
      { field: "size", descending: true },
    ]));
    expect(out).toEqual([
      { property: "size", isAscending: false },
      { property: "receivedAt", isAscending: false },
    ]);
  });

  it("still ends on the tiebreak when stripping removed everything else", () => {
    expect(withoutOptionalSorts(comparatorsFor("unreadFirst"))).toEqual([{ property: "receivedAt", isAscending: false }]);
  });

  it("leaves a sort that was never optional alone", () => {
    const plain = comparatorsFor("largest");
    expect(withoutOptionalSorts(plain)).toEqual(plain);
  });
});

describe("appliesTo", () => {
  it("covers only the inbox on the narrow scope", () => {
    // Unread-first is what people want where they triage, and confusing in
    // Sent, where everything is read.
    expect(appliesTo("inbox", "inbox")).toBe(true);
    expect(appliesTo("inbox", "sent")).toBe(false);
    expect(appliesTo("inbox", null)).toBe(false);
  });

  it("covers everything on the wide one", () => {
    expect(appliesTo("all", "sent")).toBe(true);
    expect(appliesTo("all", null)).toBe(true);
  });
});
