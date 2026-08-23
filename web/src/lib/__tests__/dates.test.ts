import { describe, expect, it } from "vitest";
import { formatDuration, parseDuration, zonedToDate, dateToZonedLocal, monthGrid } from "../dates";

describe("dates", () => {
  it("parses and formats ISO durations", () => {
    expect(parseDuration("PT1H30M")).toBe(5400);
    expect(parseDuration("P1DT2H")).toBe(93600);
    expect(parseDuration("-PT15M")).toBe(-900);
    expect(formatDuration(5400)).toBe("PT1H30M");
    expect(formatDuration(-600)).toBe("-PT10M");
    expect(formatDuration(86400)).toBe("P1D");
  });
  it("converts zoned local times to instants", () => {
    const d = zonedToDate("2024-07-01T12:00:00", "America/New_York");
    expect(d.toISOString()).toBe("2024-07-01T16:00:00.000Z");
    expect(dateToZonedLocal(d, "Europe/Berlin")).toBe("2024-07-01T18:00:00");
  });
  it("builds a 42-day month grid starting on week start", () => {
    const g = monthGrid(new Date(2024, 1, 15), 1);
    expect(g).toHaveLength(42);
    expect(g[0]!.getDay()).toBe(1);
  });
});
