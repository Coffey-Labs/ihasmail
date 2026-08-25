import { describe, expect, it } from "vitest";
import { buildSubmission } from "@/store/compose";

/**
 * JMAP has no writable "send this later" property: `sendAt` is server-derived,
 * and the delay is asked for with an RFC 4865 FUTURERELEASE parameter on the
 * envelope. Getting that wrong sends the message immediately, which is not the
 * kind of mistake a user can undo.
 */
const base = {
  identityId: "i1",
  fromEmail: "john@example.org",
  emailRef: "#m",
  rcpts: [{ email: "ann@example.com" }],
  sentId: "sent",
  draftsId: "drafts",
  scheduledId: "sched",
};

describe("buildSubmission", () => {
  it("sends immediately when nothing is scheduled", () => {
    const { create, onSuccessUpdateEmail } = buildSubmission({ ...base, sendAt: null });
    const envelope = create.envelope as { mailFrom: Record<string, unknown> };
    expect(envelope.mailFrom).toEqual({ email: "john@example.org" });
    expect(envelope.mailFrom).not.toHaveProperty("parameters");
    expect(onSuccessUpdateEmail["mailboxIds/sent"]).toBe(true);
    expect(onSuccessUpdateEmail["mailboxIds/drafts"]).toBeNull();
  });

  it("asks for the hold with HOLDUNTIL, not by setting sendAt", () => {
    const at = new Date("2026-11-20T05:00:00Z").getTime();
    const { create } = buildSubmission({ ...base, sendAt: at });
    const envelope = create.envelope as { mailFrom: { parameters?: Record<string, string> } };
    expect(envelope.mailFrom.parameters).toEqual({ HOLDUNTIL: "2026-11-20T05:00:00Z" });
    expect(create).not.toHaveProperty("sendAt");
    expect(create).not.toHaveProperty("undoStatus");
  });

  it("files a held message under Scheduled, and keeps it out of Sent", () => {
    const { onSuccessUpdateEmail } = buildSubmission({ ...base, sendAt: Date.now() + 86_400_000 });
    expect(onSuccessUpdateEmail["mailboxIds/sched"]).toBe(true);
    // Sent would be a lie for as long as the hold lasts.
    expect(onSuccessUpdateEmail["mailboxIds/sent"]).toBeNull();
    expect(onSuccessUpdateEmail["mailboxIds/drafts"]).toBeNull();
    expect(onSuccessUpdateEmail["keywords/$draft"]).toBeNull();
  });

  it("still sends when the server has no Scheduled folder to file it in", () => {
    const { create, onSuccessUpdateEmail } = buildSubmission({ ...base, scheduledId: null, sendAt: Date.now() + 86_400_000 });
    const envelope = create.envelope as { mailFrom: { parameters?: Record<string, string> } };
    expect(envelope.mailFrom.parameters).toHaveProperty("HOLDUNTIL");
    expect(onSuccessUpdateEmail).not.toHaveProperty("mailboxIds/sched");
  });

  it("carries the identity, the message reference and every recipient", () => {
    const { create } = buildSubmission({
      ...base,
      rcpts: [{ email: "ann@example.com" }, { email: "bo@example.com" }],
      sendAt: null,
    });
    expect(create.identityId).toBe("i1");
    expect(create.emailId).toBe("#m");
    expect((create.envelope as { rcptTo: unknown[] }).rcptTo).toEqual([{ email: "ann@example.com" }, { email: "bo@example.com" }]);
  });
});
