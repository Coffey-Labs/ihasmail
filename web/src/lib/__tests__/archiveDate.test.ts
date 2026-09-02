import { describe, expect, it } from "vitest";
import { archiveSegments, archivePath, groupByArchivePath } from "@/lib/archiveDate";

/**
 * The dates below are written as local-time strings on purpose. The segments
 * follow the reader's timezone, so a test pinned to UTC instants would pass or
 * fail depending on where it ran.
 */
describe("archiveSegments", () => {
  it("gives the year, and the zero-padded month", () => {
    expect(archiveSegments("2026-09-04T10:00:00", "year")).toEqual(["2026"]);
    expect(archiveSegments("2026-09-04T10:00:00", "month")).toEqual(["2026", "09"]);
  });

  it("zero-pads every month below October, so the folders sort", () => {
    expect(archiveSegments("2026-01-15T10:00:00", "month")).toEqual(["2026", "01"]);
    expect(archiveSegments("2026-10-15T10:00:00", "month")).toEqual(["2026", "10"]);
    expect(archiveSegments("2026-12-15T10:00:00", "month")).toEqual(["2026", "12"]);
  });

  it("returns nothing to append when the date cannot be read", () => {
    // Archive itself, rather than a folder named after a guess.
    expect(archiveSegments(null, "month")).toEqual([]);
    expect(archiveSegments(undefined, "month")).toEqual([]);
    expect(archiveSegments("", "month")).toEqual([]);
    expect(archiveSegments("not a date", "month")).toEqual([]);
  });

  it("joins to a path", () => {
    expect(archivePath(["2026", "09"])).toBe("2026/09");
    expect(archivePath([])).toBe("");
  });
});

describe("groupByArchivePath", () => {
  it("keeps one destination for a selection from one month", () => {
    const groups = groupByArchivePath(
      [
        { id: "a", receivedAt: "2026-09-04T10:00:00" },
        { id: "b", receivedAt: "2026-09-28T10:00:00" },
      ],
      "month",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.segments).toEqual(["2026", "09"]);
    expect(groups[0]!.ids).toEqual(["a", "b"]);
  });

  it("splits a selection that spans months, which is the case that matters", () => {
    const groups = groupByArchivePath(
      [
        { id: "a", receivedAt: "2026-09-04T10:00:00" },
        { id: "b", receivedAt: "2026-08-30T10:00:00" },
        { id: "c", receivedAt: "2026-09-01T10:00:00" },
      ],
      "month",
    );
    expect(groups.map((g) => g.segments)).toEqual([
      ["2026", "09"],
      ["2026", "08"],
    ]);
    expect(groups[0]!.ids).toEqual(["a", "c"]);
    expect(groups[1]!.ids).toEqual(["b"]);
  });

  it("collapses the same span back to one group at year granularity", () => {
    const entries = [
      { id: "a", receivedAt: "2026-09-04T10:00:00" },
      { id: "b", receivedAt: "2026-02-28T10:00:00" },
    ];
    expect(groupByArchivePath(entries, "month")).toHaveLength(2);
    expect(groupByArchivePath(entries, "year")).toHaveLength(1);
  });

  it("orders groups by where their first message appeared", () => {
    const groups = groupByArchivePath(
      [
        { id: "a", receivedAt: "2024-01-04T10:00:00" },
        { id: "b", receivedAt: "2026-01-04T10:00:00" },
      ],
      "year",
    );
    expect(groups.map((g) => archivePath(g.segments))).toEqual(["2024", "2026"]);
  });

  it("gathers the undatable ones into their own group, bound for Archive itself", () => {
    const groups = groupByArchivePath(
      [
        { id: "a", receivedAt: "2026-09-04T10:00:00" },
        { id: "b", receivedAt: null },
        { id: "c", receivedAt: "bad" },
      ],
      "month",
    );
    expect(groups).toHaveLength(2);
    expect(groups[1]!.segments).toEqual([]);
    expect(groups[1]!.ids).toEqual(["b", "c"]);
  });

  it("has nothing to do with an empty selection", () => {
    expect(groupByArchivePath([], "month")).toEqual([]);
  });
});
