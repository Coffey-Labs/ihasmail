import { describe, expect, it } from "vitest";
import {
  canScheduleSend,
  describeSpan,
  holdUntil,
  maxDelayMs,
  MIN_LEAD_MS,
  schedulePresets,
  scheduleError,
} from "@/lib/schedule";

/** Stalwart's own numbers, from the account capability it advertises. */
const STALWART = { maxDelayedSend: 86400 * 30, submissionExtensions: { FUTURERELEASE: [], SIZE: [], DSN: [] } };
const DAY = 86_400_000;

describe("capability detection", () => {
  it("accepts a server that advertises FUTURERELEASE and a non-zero window", () => {
    expect(canScheduleSend(STALWART)).toBe(true);
    expect(maxDelayMs(STALWART)).toBe(30 * DAY);
  });

  it("refuses a server whose window is zero, which RFC 8621 defines as unsupported", () => {
    expect(canScheduleSend({ ...STALWART, maxDelayedSend: 0 })).toBe(false);
  });

  it("refuses a server that offers a window but not the extension", () => {
    expect(canScheduleSend({ maxDelayedSend: 86400, submissionExtensions: { DSN: [] } })).toBe(false);
  });

  it("refuses the empty capability object Stalwart puts at session level", () => {
    expect(canScheduleSend({})).toBe(false);
    expect(canScheduleSend(undefined)).toBe(false);
    expect(maxDelayMs(undefined)).toBe(0);
  });
});

describe("holdUntil", () => {
  it("is an RFC 3339 UTC date-time, which is what Stalwart parses since 0.16.17", () => {
    expect(holdUntil(new Date("2026-11-20T05:00:00Z"))).toBe("2026-11-20T05:00:00Z");
  });

  it("drops milliseconds, so the sendAt that comes back agrees with what we asked", () => {
    expect(holdUntil(new Date("2026-11-20T05:00:00.789Z"))).toBe("2026-11-20T05:00:00Z");
  });
});

describe("schedulePresets", () => {
  // A Monday morning: everything is still ahead.
  const monday9am = new Date(2026, 7, 24, 9, 0, 0, 0);

  it("offers later today, tomorrow and next Monday from a Monday morning", () => {
    const ids = schedulePresets(monday9am, 30 * DAY).map((p) => p.id);
    expect(ids).toEqual(["later-today", "tomorrow-morning", "tomorrow-afternoon", "monday-morning"]);
  });

  it("puts the times where the labels say", () => {
    const by = Object.fromEntries(schedulePresets(monday9am, 30 * DAY).map((p) => [p.id, p.at]));
    expect(by["later-today"]!.getHours()).toBe(17);
    expect(by["later-today"]!.getDate()).toBe(24);
    expect(by["tomorrow-morning"]!.getDate()).toBe(25);
    expect(by["tomorrow-morning"]!.getHours()).toBe(8);
    expect(by["tomorrow-afternoon"]!.getHours()).toBe(13);
  });

  it("skips a Monday for the Monday a week out, not today", () => {
    const monday = schedulePresets(monday9am, 30 * DAY).find((p) => p.id === "monday-morning")!;
    expect(monday.at.getDate()).toBe(31);
    expect(monday.at.getDay()).toBe(1);
  });

  it("finds next Monday from mid-week", () => {
    const wednesday = new Date(2026, 7, 26, 9, 0, 0, 0);
    const monday = schedulePresets(wednesday, 30 * DAY).find((p) => p.id === "monday-morning")!;
    expect(monday.at.getDate()).toBe(31);
    expect(monday.at.getDay()).toBe(1);
  });

  it("drops later today once the evening has passed", () => {
    const ids = schedulePresets(new Date(2026, 7, 24, 18, 0, 0, 0), 30 * DAY).map((p) => p.id);
    expect(ids).not.toContain("later-today");
    expect(ids).toContain("tomorrow-morning");
  });

  it("offers nothing beyond what the server will hold", () => {
    // A two-hour window reaches this evening but nothing after it.
    const ids = schedulePresets(new Date(2026, 7, 24, 16, 0, 0, 0), 2 * 3_600_000).map((p) => p.id);
    expect(ids).toEqual(["later-today"]);
  });
});

describe("scheduleError", () => {
  const now = new Date(2026, 7, 24, 9, 0, 0, 0);

  it("accepts a time comfortably ahead", () => {
    expect(scheduleError(new Date(now.getTime() + DAY), now, 30 * DAY)).toBeNull();
  });

  it("refuses the past and the almost-now", () => {
    expect(scheduleError(new Date(now.getTime() - 1000), now, 30 * DAY)).toMatch(/at least a minute/);
    expect(scheduleError(new Date(now.getTime() + MIN_LEAD_MS - 1), now, 30 * DAY)).toMatch(/at least a minute/);
  });

  it("refuses what the server would reject, naming the limit", () => {
    const err = scheduleError(new Date(now.getTime() + 31 * DAY), now, 30 * DAY);
    expect(err).toMatch(/30 days/);
  });

  it("refuses an unparseable date rather than sending one", () => {
    expect(scheduleError(new Date("nonsense"), now, 30 * DAY)).toMatch(/Pick a date/);
  });
});

describe("describeSpan", () => {
  it("reads in days when there are days, hours otherwise", () => {
    expect(describeSpan(30 * DAY)).toBe("30 days");
    expect(describeSpan(DAY)).toBe("1 day");
    expect(describeSpan(2 * 3_600_000)).toBe("2 hours");
    expect(describeSpan(3_600_000)).toBe("1 hour");
  });
});
