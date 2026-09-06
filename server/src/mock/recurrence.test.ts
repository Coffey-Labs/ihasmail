import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandOccurrences, occurrenceAt, occurrenceView, parseSyntheticId, splitOccurrencePatch, syntheticId } from "./recurrence.js";

/**
 * The mock expands recurrences so that per-occurrence editing can be developed
 * against something. What it has to get right is not the expansion — that is
 * the easy half — but the three things a live server does that a client will
 * otherwise be written against wrongly:
 *
 * - every expanded id is synthetic, one-offs included;
 * - an occurrence carries a `recurrenceId` and no rule;
 * - a per-occurrence patch loses some properties in silence.
 */

const WEEKDAYS = { "@type": "RecurrenceRule", frequency: "weekly", byDay: [{ day: "mo" }, { day: "tu" }, { day: "we" }, { day: "th" }, { day: "fr" }] };

/** A standup at 09:00 every weekday, starting Monday 2026-09-07. */
const series = () => ({ id: "ev1", "@type": "Event", uid: "u1", title: "Standup", start: "2026-09-07T09:00:00", duration: "PT30M", recurrenceRule: WEEKDAYS } as Record<string, unknown>);
const oneOff = () => ({ id: "ev2", "@type": "Event", uid: "u2", title: "Lunch", start: "2026-09-08T12:00:00", duration: "PT1H" } as Record<string, unknown>);

const week = (from: string, to: string) => [new Date(from), new Date(to)] as const;

describe("expandOccurrences", () => {
  it("gives a weekday rule five dates in a week and skips the weekend", () => {
    const [a, b] = week("2026-09-07T00:00:00", "2026-09-14T00:00:00");
    const out = expandOccurrences(series(), a, b);
    assert.deepEqual(out.map((o) => o.start), [
      "2026-09-07T09:00:00", "2026-09-08T09:00:00", "2026-09-09T09:00:00",
      "2026-09-10T09:00:00", "2026-09-11T09:00:00",
    ]);
  });

  it("gives a one-off exactly one occurrence, at index 0", () => {
    const [a, b] = week("2026-09-01T00:00:00", "2026-10-01T00:00:00");
    const out = expandOccurrences(oneOff(), a, b);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.index, 0);
  });

  it("honours count", () => {
    const ev = { ...series(), recurrenceRule: { ...WEEKDAYS, count: 3 } };
    const [a, b] = week("2026-09-07T00:00:00", "2026-10-01T00:00:00");
    assert.equal(expandOccurrences(ev, a, b).length, 3);
  });

  it("drops an excluded date from the expansion, keeping the series positions", () => {
    const ev = { ...series(), recurrenceOverrides: { "2026-09-08T09:00:00": { excluded: true } } };
    const [a, b] = week("2026-09-07T00:00:00", "2026-09-14T00:00:00");
    const out = expandOccurrences(ev, a, b);
    assert.deepEqual(out.map((o) => o.start), [
      "2026-09-07T09:00:00", "2026-09-09T09:00:00", "2026-09-10T09:00:00", "2026-09-11T09:00:00",
    ]);
    // The position within the series is unchanged — Wednesday is still the
    // third date the rule produces, whatever happened to Tuesday. It is the
    // *id* built on top of that which moves, and only after a write.
    assert.equal(out[1]!.index, 2);
  });

  it("carries an override onto the occurrence it keys", () => {
    const ev = { ...series(), recurrenceOverrides: { "2026-09-09T09:00:00": { title: "Standup (long)" } } };
    const [a, b] = week("2026-09-07T00:00:00", "2026-09-14T00:00:00");
    const out = expandOccurrences(ev, a, b);
    assert.deepEqual(out.find((o) => o.start === "2026-09-09T09:00:00")!.override, { title: "Standup (long)" });
  });
});

describe("occurrenceView", () => {
  it("strips the rule, sets recurrenceId, and points baseEventId at the master", () => {
    const base = series();
    const occ = occurrenceAt(base, "2026-09-08T09:00:00")!;
    const view = occurrenceView(base, occ);
    assert.equal(view.id, syntheticId("ev1", "2026-09-08T09:00:00"));
    assert.equal(view.baseEventId, "ev1");
    assert.equal(view.recurrenceId, "2026-09-08T09:00:00");
    assert.equal(view.recurrenceRule, undefined);
    assert.equal(view.recurrenceOverrides, undefined);
  });

  it("gives a one-off a synthetic id over a different base, and no recurrenceId", () => {
    // Both halves matter. The id is why `baseEventId` proves nothing about a
    // series; the absent `recurrenceId` is why a one-off does not read as one.
    const base = oneOff();
    const view = occurrenceView(base, occurrenceAt(base, "2026-09-08T12:00:00")!);
    assert.equal(view.id, "ev2-r20260908T120000");
    assert.equal(view.baseEventId, "ev2");
    assert.notEqual(view.id, view.baseEventId);
    assert.equal(view.recurrenceId, undefined);
  });

  it("lets an override win over the series", () => {
    const base = { ...series(), recurrenceOverrides: { "2026-09-08T09:00:00": { title: "Moved" } } };
    // The same recurrence id as before the override was written, because that
    // is now the whole point: the write does not move any other occurrence.
    const view = occurrenceView(base, occurrenceAt(base, "2026-09-08T09:00:00")!);
    assert.equal(view.start, "2026-09-08T09:00:00");
    assert.equal(view.title, "Moved");
  });
});

describe("parseSyntheticId", () => {
  it("round-trips", () => {
    assert.deepEqual(parseSyntheticId(syntheticId("ev1", "2026-09-08T09:00:00")),
      { baseId: "ev1", recurrenceId: "2026-09-08T09:00:00" });
  });
  it("does not claim a stored id", () => {
    assert.equal(parseSyntheticId("ev1"), null);
  });
  it("does not claim an id that merely ends in digits", () => {
    assert.equal(parseSyntheticId("ev1-r2026"), null);
  });
});

describe("splitOccurrencePatch", () => {
  it("applies what an occurrence takes", () => {
    const { rejected, applied } = splitOccurrencePatch({ title: "Just today", color: "#f00" });
    assert.equal(rejected, undefined);
    assert.deepEqual(applied, { title: "Just today", color: "#f00" });
  });

  it("refuses an event-level property by name", () => {
    assert.equal(splitOccurrencePatch({ calendarIds: { c2: true } }).rejected, "calendarIds");
    assert.equal(splitOccurrencePatch({ hideAttendees: true }).rejected, "hideAttendees");
  });

  it("drops an inherited property in silence, which is the dangerous half", () => {
    // No `rejected`, nothing applied, and a real server would still answer
    // "updated". Anything that trusts the response believes this landed.
    const { rejected, applied } = splitOccurrencePatch({ privacy: "private", recurrenceRule: null });
    assert.equal(rejected, undefined);
    assert.deepEqual(applied, {});
  });

  it("judges a pointer patch on its first token", () => {
    assert.deepEqual(splitOccurrencePatch({ "participants/me/participationStatus": "accepted" }).applied,
      { "participants/me/participationStatus": "accepted" });
    assert.deepEqual(splitOccurrencePatch({ "participants/me/calendarAddress": "mailto:x@y" }).applied, {});
  });
});


describe("synthetic ids survive a write", () => {
  /*
   * This used to assert the opposite, and the reversal is the point.
   *
   * Up to 0.16.20 a synthetic id encoded a position, so writing one override
   * renumbered the series and a held id silently began naming a different
   * date — confirmed live on 2026-08-31, and reproduced here on purpose so a
   * client could not be written against a comfort the server did not offer.
   *
   * 0.16.21 identifies an occurrence by its recurrence id instead.
   * **Confirmed live on 0.16.21 (2026-09-06):** a five-week series was
   * expanded, its third occurrence retitled through the synthetic id, and all
   * five original ids re-read. Every one resolved, and every one still named
   * its own date. So the hazard is gone, and the mock stops teaching it.
   */
  it("keeps a cached id on the same date after an override is written", () => {
    const before = series();
    const held = syntheticId("ev1", occurrenceAt(before, "2026-09-10T09:00:00")!.recurrenceId);
    const dateBefore = occurrenceAt(before, parseSyntheticId(held)!.recurrenceId)!.start;

    const after = { ...before, recurrenceOverrides: { "2026-09-07T09:00:00": { title: "changed" } } };
    const dateAfter = occurrenceAt(after, parseSyntheticId(held)!.recurrenceId)!.start;

    assert.equal(dateAfter, dateBefore);
  });

  it("resolves every id of a series after one of them is overridden", () => {
    const before = series();
    const held = expandOccurrences(before, new Date("2026-09-07T00:00:00"), new Date("2026-09-12T00:00:00"))
      .map((o) => syntheticId("ev1", o.recurrenceId));
    const after = { ...before, recurrenceOverrides: { "2026-09-09T09:00:00": { title: "changed" } } };
    for (const id of held) {
      const occ = occurrenceAt(after, parseSyntheticId(id)!.recurrenceId);
      assert.ok(occ, `${id} should still resolve`);
      assert.equal(syntheticId("ev1", occ.recurrenceId), id);
    }
  });

  it("still refuses an id whose date the rule no longer generates", () => {
    const base = { ...series(), recurrenceOverrides: { "2026-09-09T09:00:00": { excluded: true } } };
    assert.equal(occurrenceAt(base, "2026-09-09T09:00:00"), null);
  });
});


describe("an override that moves an occurrence", () => {
  /*
   * Confirmed live on 0.16.20 (2026-08-31): one occurrence of a weekly 09:00
   * series moved to 14:00 comes back with `start` at 14:00 and `recurrenceId`
   * still at 09:00 — the slot the rule made, which the move does not touch.
   *
   * The mock used to clobber the override's `start` with the slot time, so a
   * moved occurrence did not move. That made per-occurrence *time* editing —
   * one of the main things the feature is for — look broken against the mock
   * and fine against the server.
   */
  const moved = () => ({
    ...series(),
    recurrenceOverrides: { "2026-09-08T09:00:00": { start: "2026-09-08T14:00:00" } },
  });

  it("moves the occurrence and leaves its recurrenceId on the original slot", () => {
    const [a, b] = week("2026-09-07T00:00:00", "2026-09-14T00:00:00");
    const occ = expandOccurrences(moved(), a, b).find((o) => o.recurrenceId === "2026-09-08T09:00:00")!;
    assert.equal(occ.start, "2026-09-08T14:00:00");
    assert.equal(occ.recurrenceId, "2026-09-08T09:00:00");
  });

  it("shows the moved time on the occurrence a get returns", () => {
    const base = moved();
    const occ = expandOccurrences(base, new Date("2026-09-07T00:00:00"), new Date("2026-09-14T00:00:00"))
      .find((o) => o.recurrenceId === "2026-09-08T09:00:00")!;
    const view = occurrenceView(base, occ);
    assert.equal(view.start, "2026-09-08T14:00:00");
    assert.equal(view.recurrenceId, "2026-09-08T09:00:00");
  });

  it("keeps the occurrence findable by recurrenceId after the move", () => {
    // This is the property the store depends on: `recurrenceId` survives both
    // a renumbering and a move, so it is the handle a mutation resolves from.
    const base = moved();
    const all = expandOccurrences(base, new Date("2026-09-01T00:00:00"), new Date("2026-10-01T00:00:00"));
    assert.equal(all.filter((o) => o.recurrenceId === "2026-09-08T09:00:00").length, 1);
  });
});
