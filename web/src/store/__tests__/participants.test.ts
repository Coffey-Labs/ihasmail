import { describe, expect, it } from "vitest";
import { participantAddresses, participantEmail, isAttendee, eventRule, makeParticipant } from "@/store/calendar";
import type { CalendarEvent, JSCalendarParticipant } from "@/jmap/types";

/**
 * Stalwart 0.16.19 and RFC 8984 disagree about where a participant's address
 * lives. Sent the RFC's way, Stalwart keeps the event and drops the participant
 * map without a word — guests vanished and no invitation was ever sent (#26).
 * Shapes below are what a live 0.16.19 returned.
 */
const p = (o: Partial<JSCalendarParticipant>): JSCalendarParticipant => ({ roles: {}, ...o });
const ev = (o: Partial<CalendarEvent>): CalendarEvent => ({ id: "e1", "@type": "Event", uid: "u1", calendarIds: { c1: true }, start: "2030-01-01T10:00:00", ...o } as CalendarEvent);

describe("participant addresses", () => {
  it("reads Stalwart's calendarAddress", () => {
    expect(participantEmail(p({ calendarAddress: "mailto:guest@example.com" }))).toBe("guest@example.com");
  });
  it("still reads the RFC 8984 spellings, for events written by other clients", () => {
    expect(participantEmail(p({ sendTo: { imip: "mailto:ada@example.org" } }))).toBe("ada@example.org");
    expect(participantEmail(p({ email: "ada@example.org" }))).toBe("ada@example.org");
    expect(participantAddresses(p({ calendarAddress: "mailto:A@b.com", email: "c@d.com" }))).toEqual(["mailto:a@b.com", "mailto:c@d.com"]);
  });
  it("has no address to offer when the participant carries none", () => {
    expect(participantEmail(p({ name: "Nameless" }))).toBe("");
  });
  it("counts a participant as attending under either role name", () => {
    expect(isAttendee(p({ roles: { attendee: true } }))).toBe(true);
    expect(isAttendee(p({ roles: { required: true } }))).toBe(true); // what Stalwart writes for REQ-PARTICIPANT
    expect(isAttendee(p({ roles: { optional: true } }))).toBe(true);
    expect(isAttendee(p({ roles: { owner: true } }))).toBe(false);
  });
});

describe("makeParticipant", () => {
  it("addresses a guest the way Stalwart stores them", () => {
    const guest = makeParticipant("guest@example.com", "Guest", "attendee");
    expect(guest.calendarAddress).toBe("mailto:guest@example.com");
    expect(guest.sendTo).toBeUndefined();
    expect(guest.roles).toEqual({ attendee: true, required: true });
    expect(guest.participationStatus).toBe("needs-action");
    expect(guest.expectReply).toBe(true);
  });
  it("marks the organizer as owner and keeps a status already given", () => {
    const me = makeParticipant("john@example.org", "John Coffey", "owner");
    expect(me.roles).toEqual({ owner: true, attendee: true });
    expect(me.participationStatus).toBe("accepted");
    expect(me.expectReply).toBe(false);
    expect(makeParticipant("g@example.com", null, "attendee", "declined").participationStatus).toBe("declined");
  });
});

describe("eventRule", () => {
  it("reads Stalwart's singular rule and the RFC's array", () => {
    expect(eventRule(ev({ recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly" } }))?.frequency).toBe("weekly");
    expect(eventRule(ev({ recurrenceRules: [{ "@type": "RecurrenceRule", frequency: "daily" }] }))?.frequency).toBe("daily");
    expect(eventRule(ev({}))).toBeUndefined();
  });
});
