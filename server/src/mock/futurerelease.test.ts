import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { holdUntilOf, undoStatusOf } from "./futurerelease.js";

const NOW = Date.parse("2026-08-24T12:00:00Z");
const envelope = (parameters: Record<string, string> | null) => ({
  mailFrom: { email: "john@example.org", ...(parameters ? { parameters } : {}) },
  rcptTo: [{ email: "ann@example.com" }],
});

describe("FUTURERELEASE parameters", () => {
  it("reads HOLDUNTIL as an RFC 3339 date-time", () => {
    const at = holdUntilOf(envelope({ HOLDUNTIL: "2026-11-20T05:00:00Z" }), NOW);
    assert.equal(at, Date.parse("2026-11-20T05:00:00Z"));
  });

  it("reads HOLDFOR as a count of seconds from now", () => {
    assert.equal(holdUntilOf(envelope({ HOLDFOR: "3600" }), NOW), NOW + 3_600_000);
  });

  it("matches the parameter name whatever its case, as an SMTP parser does", () => {
    assert.equal(holdUntilOf(envelope({ holduntil: "2026-11-20T05:00:00Z" }), NOW), Date.parse("2026-11-20T05:00:00Z"));
  });

  it("means send now when neither parameter is present", () => {
    assert.equal(holdUntilOf(envelope(null), NOW), null);
    assert.equal(holdUntilOf(envelope({}), NOW), null);
    assert.equal(holdUntilOf(undefined, NOW), null);
  });

  it("refuses both parameters at once, as Stalwart does with a 501", () => {
    assert.ok(Number.isNaN(holdUntilOf(envelope({ HOLDUNTIL: "2026-11-20T05:00:00Z", HOLDFOR: "600" }), NOW)));
  });

  it("refuses values that will not parse", () => {
    assert.ok(Number.isNaN(holdUntilOf(envelope({ HOLDUNTIL: "next tuesday" }), NOW)));
    assert.ok(Number.isNaN(holdUntilOf(envelope({ HOLDFOR: "soon" }), NOW)));
    assert.ok(Number.isNaN(holdUntilOf(envelope({ HOLDFOR: "0" }), NOW)));
    assert.ok(Number.isNaN(holdUntilOf(envelope({ HOLDFOR: "-60" }), NOW)));
  });

  it("accepts a Unix timestamp only as the date it is not", () => {
    // 0.16.16 briefly wanted seconds-since-epoch here; 0.16.17 restored RFC
    // 3339. A bare number must not be mistaken for a valid hold.
    assert.ok(Number.isNaN(holdUntilOf(envelope({ HOLDUNTIL: "1795000000" }), NOW)));
  });
});

describe("undoStatus", () => {
  const sub = (sendAt: string, undoStatus: string | null = null) => ({ sendAt, undoStatus });

  it("is pending while the release time is still ahead", () => {
    assert.equal(undoStatusOf(sub("2026-11-20T05:00:00Z"), NOW), "pending");
  });

  it("is final once the release time has passed", () => {
    assert.equal(undoStatusOf(sub("2026-08-24T11:59:59Z"), NOW), "final");
    assert.equal(undoStatusOf(sub("2026-08-24T12:00:00Z"), NOW), "final");
  });

  it("stays canceled regardless of the clock", () => {
    assert.equal(undoStatusOf(sub("2026-11-20T05:00:00Z", "canceled"), NOW), "canceled");
    assert.equal(undoStatusOf(sub("2026-01-01T00:00:00Z", "canceled"), NOW), "canceled");
  });
});
