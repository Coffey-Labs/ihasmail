import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { client } from "@/jmap/client";
import type { SharedContent } from "@/lib/shareTarget";

/**
 * What a share becomes once it reaches the composer.
 *
 * The signature is the part worth a test. `open()` only fits one when it is
 * given no body at all, so the obvious implementation -- pass the shared text
 * straight to `open()` -- silently drops the signature from every message that
 * started as a share, and nothing about the draft looks wrong.
 */

const IDENTITY = {
  id: "i1",
  name: "John",
  email: "john@example.org",
  replyTo: null,
  htmlSignature: "<p>-- <br>John</p>",
  textSignature: "-- \nJohn",
};

function share(over: Partial<SharedContent> = {}): SharedContent {
  return { title: "", text: "", url: "", files: [], ...over };
}

beforeEach(() => {
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useMail.setState({ accountId: "a1", identities: [IDENTITY] as never });
  // addFiles uploads as it goes; nothing here is testing the upload, and a
  // real one would reach for the network.
  vi.spyOn(client, "upload").mockResolvedValue({ blobId: "b1", type: "image/png", size: 6 } as never);
});

// Without this the spy installed above is the same one every test, so its call
// count is cumulative and "uploaded twice" quietly means "twice, plus whatever
// the test before it uploaded".
afterEach(() => {
  vi.restoreAllMocks();
});

const draftFor = (key: string) => useCompose.getState().drafts.find((d) => d.key === key)!;

describe("opening a share as a draft", () => {
  it("makes the shared title the subject and addresses nothing", () => {
    // A share says what to send, never who to. Anything else would be putting
    // a recipient in a field the sharer never filled in.
    const d = draftFor(useCompose.getState().openFromShare(share({ title: "Holiday plans" })));
    expect(d.subject).toBe("Holiday plans");
    expect(d.to).toEqual([]);
    expect(d.cc).toEqual([]);
  });

  it("puts the shared text above the signature, not instead of it", () => {
    const d = draftFor(useCompose.getState().openFromShare(share({ text: "Look at this" })));
    expect(d.text).toContain("Look at this");
    expect(d.text).toContain("John");
    expect(d.html).toContain("Look at this");
    expect(d.html).toContain("-- ");
    // Above, not below: the reply goes where the caret lands.
    expect(d.html.indexOf("Look at this")).toBeLessThan(d.html.indexOf("-- "));
  });

  it("carries a shared link into the body", () => {
    const d = draftFor(useCompose.getState().openFromShare(share({ text: "worth reading", url: "https://example.com/a" })));
    expect(d.text).toContain("https://example.com/a");
  });

  it("keeps the signature when a share carried nothing but files", () => {
    const key = useCompose.getState().openFromShare(share({ files: [new File(["pixels"], "beach.png", { type: "image/png" })] }));
    const d = draftFor(key);
    expect(d.html).toContain("John");
    expect(d.attachments.map((a) => [a.name, a.type])).toEqual([["beach.png", "image/png"]]);
  });

  it("attaches every shared file, and starts each one uploading", () => {
    const files = [
      new File(["a"], "one.png", { type: "image/png" }),
      new File(["b"], "two.pdf", { type: "application/pdf" }),
    ];
    const d = draftFor(useCompose.getState().openFromShare(share({ title: "Two things", files })));
    expect(d.attachments).toHaveLength(2);
    expect(d.attachments.every((a) => a.error === null)).toBe(true);
    expect(client.upload).toHaveBeenCalledTimes(2);
  });

  it("opens a plain draft for a share that carried only a subject", () => {
    const d = draftFor(useCompose.getState().openFromShare(share({ title: "Just this" })));
    expect(d.subject).toBe("Just this");
    expect(d.attachments).toEqual([]);
  });
});
