import { describe, expect, it } from "vitest";
import { appointmentDraft, nextHalfHour } from "@/lib/appointment";
import type { Email, EmailBodyPart } from "@/jmap/types";

/**
 * A reminder made out of a mail: the subject becomes the title and the body
 * becomes the description, and the reader supplies the one thing the message
 * cannot — when it happens. What these pin is that the copy is faithful and
 * bounded, because everything else about the event is the editor's job.
 */

function part(partId: string, type: string): EmailBodyPart {
  return { partId, type } as EmailBodyPart;
}

function email(parts: Partial<Email>): Email {
  return { id: "m1", subject: null, ...parts } as Email;
}

function body(subject: string, type: "text/plain" | "text/html", value: string): Email {
  const key = type === "text/plain" ? "textBody" : "htmlBody";
  return email({ subject, [key]: [part("1", type)], bodyValues: { 1: { value, isEncodingProblem: false, isTruncated: false } } });
}

const text = (value: string) => body("Water bill", "text/plain", value);

describe("the time an appointment starts", () => {
  it("rounds up to the next half hour", () => {
    expect(nextHalfHour(new Date("2026-08-31T09:12:40")).toTimeString().slice(0, 5)).toBe("09:30");
    expect(nextHalfHour(new Date("2026-08-31T09:41:00")).toTimeString().slice(0, 5)).toBe("10:00");
  });

  it("moves on from a time already on the boundary, rather than starting now", () => {
    expect(nextHalfHour(new Date("2026-08-31T09:30:00")).toTimeString().slice(0, 5)).toBe("10:00");
  });

  it("runs for an hour", () => {
    const d = appointmentDraft(text("anything"), new Date("2026-08-31T09:12:00"));
    expect(d.end.getTime() - d.start.getTime()).toBe(3600_000);
    expect(d.allDay).toBe(false);
  });
});

describe("what is copied from the message", () => {
  it("takes the subject as the title and the body as the description", () => {
    const d = appointmentDraft(text("Due on the 14th.\nAccount 4471.\n"));
    expect(d.title).toBe("Water bill");
    expect(d.description).toBe("Due on the 14th.\nAccount 4471.");
  });

  it("reads an HTML-only message as text, so the description is not markup", () => {
    const d = appointmentDraft(body("Renewal", "text/html", "<p>Renews <b>Friday</b></p>"));
    expect(d.description).toBe("Renews Friday");
  });

  it("leaves the title empty when there is no subject, for the editor to prompt for", () => {
    expect(appointmentDraft(email({ subject: null })).title).toBe("");
  });

  /*
   * A newsletter is a message too. The whole body would be stored on the
   * event, synced everywhere, and shown in a three-row box, so the tail is
   * dropped — visibly, so a truncated bill is not read as the whole of it.
   */
  it("truncates a body too long to be a description", () => {
    const d = appointmentDraft(text("x".repeat(9000)));
    expect(d.description).toHaveLength(5001);
    expect(d.description.endsWith("…")).toBe(true);
  });
});

const between = (parts: Partial<Email>) => email({ subject: "Kickoff", ...parts });
const addr = (email: string, name: string | null = null) => ({ name, email });

describe("who is invited", () => {
  it("carries the sender and everyone it was addressed to", () => {
    const d = appointmentDraft(
      between({ from: [addr("grace@example.org", "Grace")], to: [addr("me@example.com"), addr("alan@example.org")], cc: [addr("ada@example.org")] }),
      new Date(),
      ["me@example.com"],
    );
    expect(d.attendees.map((a) => a.email)).toEqual(["grace@example.org", "alan@example.org", "ada@example.org"]);
    expect(d.attendees[0]?.name).toBe("Grace");
  });

  it("leaves the reader out, whatever case their address was written in", () => {
    const d = appointmentDraft(between({ from: [addr("grace@example.org")], to: [addr("Me@Example.com")] }), new Date(), ["me@example.com"]);
    expect(d.attendees.map((a) => a.email)).toEqual(["grace@example.org"]);
  });

  it("counts someone once, however many headers they appear in", () => {
    const d = appointmentDraft(between({ from: [addr("grace@example.org")], to: [addr("grace@example.org")], cc: [addr("GRACE@example.org")] }));
    expect(d.attendees).toHaveLength(1);
  });

  /*
   * On a message the reader sent, a blind copy is still a recipient — and
   * putting one on a guest list shows them to every other guest. Turning a
   * hidden copy into a visible one is not something a menu item may do.
   */
  it("never turns a blind copy into a guest", () => {
    const d = appointmentDraft(between({ from: [addr("me@example.com")], to: [addr("alan@example.org")], bcc: [addr("secret@example.org")] }), new Date(), ["me@example.com"]);
    expect(d.attendees.map((a) => a.email)).toEqual(["alan@example.org"]);
  });

  it("invites nobody when the message has no addresses at all", () => {
    expect(appointmentDraft(between({})).attendees).toEqual([]);
  });
});
