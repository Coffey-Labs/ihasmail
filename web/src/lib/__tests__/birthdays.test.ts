import { describe, expect, it } from "vitest";
import { birthdaysInRange, isBirthdayEvent, BIRTHDAY_ID_PREFIX } from "@/lib/birthdays";
import type { ContactCard } from "@/jmap/types";

const card = (id: string, full: string, date: { year?: number; month?: number; day?: number; utc?: string } | null, kind = "birth"): ContactCard =>
  ({
    id,
    uid: id,
    addressBookIds: { b1: true },
    name: { full },
    ...(date ? { anniversaries: { a1: { kind, date } } } : {}),
  }) as ContactCard;

const range = (from: string, to: string) => [new Date(from), new Date(to)] as const;
const names = (b: ReturnType<typeof birthdaysInRange>) => b.map((x) => `${x.name} ${x.date.toISOString().slice(0, 10)}${x.age === null ? "" : ` (${x.age})`}`);

describe("birthdaysInRange", () => {
  it("puts a birthday in the year the range covers, with the age", () => {
    const [s, e] = range("2026-01-01", "2027-01-01");
    expect(names(birthdaysInRange([card("c1", "Ada Lovelace", { year: 1990, month: 6, day: 15 })], s, e))).toEqual(["Ada Lovelace 2026-06-15 (36)"]);
  });

  it("gives no age when the card recorded only a day and month", () => {
    // Very common, and a real answer rather than a broken one.
    const [s, e] = range("2026-01-01", "2027-01-01");
    const out = birthdaysInRange([card("c1", "Ada", { month: 6, day: 15 })], s, e);
    expect(out[0]!.age).toBeNull();
    expect(out[0]!.date.getMonth()).toBe(5);
  });

  it("emits one occurrence per year across a range that spans years", () => {
    const [s, e] = range("2025-06-01", "2027-06-01");
    expect(names(birthdaysInRange([card("c1", "Ada", { year: 2000, month: 12, day: 25 })], s, e))).toEqual([
      "Ada 2025-12-25 (25)",
      "Ada 2026-12-25 (26)",
    ]);
  });

  it("leaves out a birthday outside the range", () => {
    const [s, e] = range("2026-07-01", "2026-08-01");
    expect(birthdaysInRange([card("c1", "Ada", { month: 6, day: 15 })], s, e)).toEqual([]);
  });

  it("puts 29 February on the 28th in a year that has no 29th", () => {
    // The month is the fact; moving it to 1 March is the arithmetic winning.
    const [s, e] = range("2026-01-01", "2027-01-01");
    const out = birthdaysInRange([card("c1", "Ada", { year: 2000, month: 2, day: 29 })], s, e);
    expect(out[0]!.date.getMonth()).toBe(1);
    expect(out[0]!.date.getDate()).toBe(28);
  });

  it("keeps 29 February on the 29th in a leap year", () => {
    const [s, e] = range("2028-01-01", "2029-01-01");
    const out = birthdaysInRange([card("c1", "Ada", { year: 2000, month: 2, day: 29 })], s, e);
    expect(out[0]!.date.getDate()).toBe(29);
  });

  it("reads a timestamp date as well as a partial one", () => {
    const [s, e] = range("2026-01-01", "2027-01-01");
    const out = birthdaysInRange([card("c1", "Ada", { utc: "1990-06-15T00:00:00Z" })], s, e);
    expect(out[0]!.date.getMonth()).toBe(5);
    expect(out[0]!.age).toBe(36);
  });

  it("ignores anniversaries that are not birthdays", () => {
    const [s, e] = range("2026-01-01", "2027-01-01");
    expect(birthdaysInRange([card("c1", "Ada", { month: 6, day: 15 }, "wedding")], s, e)).toEqual([]);
  });

  it("ignores a card with no anniversary and one with no usable name", () => {
    const [s, e] = range("2026-01-01", "2027-01-01");
    expect(birthdaysInRange([card("c1", "Ada", null)], s, e)).toEqual([]);
    expect(birthdaysInRange([card("c2", "", { month: 6, day: 15 })], s, e)).toEqual([]);
  });

  it("falls back to a name built from components, then to the organisation", () => {
    const [s, e] = range("2026-01-01", "2027-01-01");
    const parts = {
      id: "c1",
      uid: "c1",
      addressBookIds: {},
      name: { components: [{ kind: "given", value: "Grace" }, { kind: "surname", value: "Hopper" }] },
      anniversaries: { a1: { kind: "birth", date: { month: 12, day: 9 } } },
    } as unknown as ContactCard;
    expect(birthdaysInRange([parts], s, e)[0]!.name).toBe("Grace Hopper");

    const org = {
      id: "c2",
      uid: "c2",
      addressBookIds: {},
      organizations: { o1: { name: "Acme Ltd" } },
      anniversaries: { a1: { kind: "birth", date: { month: 3, day: 1 } } },
    } as unknown as ContactCard;
    expect(birthdaysInRange([org], s, e)[0]!.name).toBe("Acme Ltd");
  });

  it("never reports a negative age from a birth year in the future", () => {
    const [s, e] = range("2026-01-01", "2027-01-01");
    expect(birthdaysInRange([card("c1", "Ada", { year: 2040, month: 6, day: 15 })], s, e)[0]!.age).toBeNull();
  });

  it("ignores an impossible date rather than inventing one", () => {
    const [s, e] = range("2026-01-01", "2027-01-01");
    expect(birthdaysInRange([card("c1", "Ada", { month: 13, day: 40 })], s, e)).toEqual([]);
    expect(birthdaysInRange([card("c1", "Ada", { month: 4, day: 31 })], s, e)).toEqual([]);
  });

  it("returns them in date order, whatever order the contacts were in", () => {
    const [s, e] = range("2026-01-01", "2027-01-01");
    const out = birthdaysInRange(
      [card("c1", "Zoe", { month: 11, day: 2 }), card("c2", "Amy", { month: 2, day: 3 })],
      s,
      e,
    );
    expect(out.map((b) => b.name)).toEqual(["Amy", "Zoe"]);
  });

  it("gives each occurrence a stable, unique id that marks it as synthesised", () => {
    const [s, e] = range("2025-01-01", "2027-01-01");
    const out = birthdaysInRange([card("c1", "Ada", { month: 6, day: 15 })], s, e);
    expect(new Set(out.map((b) => b.id)).size).toBe(out.length);
    expect(out.every((b) => isBirthdayEvent(b.id))).toBe(true);
    expect(out[0]!.id.startsWith(BIRTHDAY_ID_PREFIX)).toBe(true);
    // Nothing that came off the server should ever look like one.
    expect(isBirthdayEvent("abc123")).toBe(false);
    expect(isBirthdayEvent(null)).toBe(false);
  });

  it("declines a range that is empty, backwards, or absurdly wide", () => {
    const cards = [card("c1", "Ada", { month: 6, day: 15 })];
    expect(birthdaysInRange(cards, new Date("2026-01-01"), new Date("2026-01-01"))).toEqual([]);
    expect(birthdaysInRange(cards, new Date("2027-01-01"), new Date("2026-01-01"))).toEqual([]);
    expect(birthdaysInRange(cards, new Date("2000-01-01"), new Date("2100-01-01"))).toEqual([]);
  });
});
