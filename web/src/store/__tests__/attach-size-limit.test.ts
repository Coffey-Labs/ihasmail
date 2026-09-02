import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useCompose, type AttachableFile } from "@/store/compose";
import { useMail } from "@/store/mail";
import type { JmapSession } from "@/jmap/types";

/**
 * `maxSizeUpload` is what the server will accept for a single *upload*
 * (RFC 8620), so it bears only on a file that is about to be uploaded.
 *
 * FEATURES has always said attach-from-Files works "however large" because a
 * blob the account already holds is attached by reference. The code applied
 * the limit to those as well, which refused a message the server was already
 * storing on the grounds that it could not have been uploaded — which it was
 * not being.
 */

const MAX = 50_000_000;
const OURS = "a1";
const THEIRS = "a2";

const file = (over: Partial<AttachableFile> = {}): AttachableFile => ({
  accountId: OURS,
  name: "big.bin",
  type: "application/octet-stream",
  size: MAX * 2,
  blobId: "b-big",
  ...over,
});

const attachments = (key: string) => useCompose.getState().drafts.find((d) => d.key === key)!.attachments;

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxSizeUpload: MAX }, [CAP.mail]: {} },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useMail.setState({
    accountId: OURS,
    identities: [{ id: "i1", name: "John", email: "john@example.org", replyTo: null }] as never,
  });
  // Nothing here should reach the network; a call would mean an upload was
  // attempted for a file that is only being referenced.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("no upload should happen");
  }));
});

describe("attaching a blob this account already holds", () => {
  it("takes it however large, because nothing is uploaded", async () => {
    const key = useCompose.getState().open();
    await useCompose.getState().addFromFiles(key, [file()]);
    const a = attachments(key)[0]!;
    expect(a.error).toBeNull();
    expect(a.blobId).toBe("b-big");
    expect(a.progress).toBe(100);
  });

  it("is complete the moment it is added, with no request made", async () => {
    const key = useCompose.getState().open();
    await useCompose.getState().addFromFiles(key, [file({ size: MAX * 10 })]);
    expect(attachments(key)[0]!.error).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("attaching a blob from somebody else's account", () => {
  it("refuses one larger than the server will accept, since it must be uploaded", async () => {
    const key = useCompose.getState().open();
    await useCompose.getState().addFromFiles(key, [file({ accountId: THEIRS, size: MAX + 1 })]);
    const a = attachments(key)[0]!;
    expect(a.error).toMatch(/Larger than/);
    expect(a.blobId).toBeNull();
  });

  it("allows one within the limit, and marks it as still needing the upload", async () => {
    const key = useCompose.getState().open();
    await useCompose.getState().addFromFiles(key, [file({ accountId: THEIRS, size: 1000, blobId: "b-small" })]);
    const a = attachments(key)[0]!;
    // The upload itself fails here because fetch is stubbed to throw; what
    // matters is that it was attempted rather than refused up front.
    expect(a.progress).not.toBe(100);
  });
});

describe("a mixture in one drop", () => {
  it("judges each file by whether it will actually be uploaded", async () => {
    const key = useCompose.getState().open();
    await useCompose.getState().addFromFiles(key, [
      file({ name: "ours.bin", size: MAX * 3 }),
      file({ name: "theirs.bin", accountId: THEIRS, size: MAX * 3, blobId: "b-theirs" }),
    ]);
    const [ours, theirs] = attachments(key);
    expect(ours!.error).toBeNull();
    expect(theirs!.error).toMatch(/Larger than/);
  });
});
