import { describe, expect, it } from "vitest";
import { contactFromAddress, contactPhoto, nameParts, withPhoto } from "../contacts";
import type { ContactCard } from "@/jmap/types";

const parts = (name: string | null, email = "a@b.io") =>
  nameParts(contactFromAddress({ name, email }) as ContactCard);

describe("contactFromAddress", () => {
  it("keeps the address as the preferred email", () => {
    const card = contactFromAddress({ name: "Ada Lovelace", email: "ada@example.org" });
    const emails = Object.values(card.emails ?? {});
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ address: "ada@example.org", pref: 1 });
    expect(card.kind).toBe("individual");
  });

  it("splits a display name into components", () => {
    expect(parts("Ada Lovelace")).toMatchObject({ given: "Ada", surname: "Lovelace" });
    expect(parts("Ada King Lovelace")).toMatchObject({ given: "Ada", middle: "King", surname: "Lovelace" });
    expect(parts("Prince")).toMatchObject({ given: "Prince", surname: "" });
  });

  it("unpicks the surname-first form", () => {
    expect(parts("Lovelace, Ada")).toMatchObject({ given: "Ada", surname: "Lovelace" });
  });

  it("strips surrounding quotes", () => {
    expect(parts('"Ada Lovelace"')).toMatchObject({ given: "Ada", surname: "Lovelace" });
  });

  it("leaves the name empty when the header carries an address, not a name", () => {
    expect(contactFromAddress({ name: "ada@example.org", email: "ada@example.org" }).name).toBeUndefined();
    expect(contactFromAddress({ name: null, email: "ada@example.org" }).name).toBeUndefined();
    expect(contactFromAddress({ name: "   ", email: "ada@example.org" }).name).toBeUndefined();
  });
});

/**
 * #376: a photo saved as a `blobId` was refused by Stalwart, which only takes
 * the `uri` form. Saving one must also leave a card's other media alone.
 */
describe("withPhoto", () => {
  const photo = { dataUrl: "data:image/jpeg;base64,AAAA", type: "image/jpeg" };

  it("puts the photo in as a data URI, never a blob id", () => {
    const media = withPhoto(undefined, photo)!;
    const [m] = Object.values(media);
    expect(m).toEqual({ "@type": "Media", kind: "photo", uri: photo.dataUrl, mediaType: "image/jpeg" });
    expect(m).not.toHaveProperty("blobId");
  });

  it("replaces an existing photo and keeps a logo", () => {
    const media = withPhoto({ old: { kind: "photo", blobId: "b1" }, l: { kind: "logo", uri: "data:image/png;base64,BB" } }, photo)!;
    expect(Object.values(media).filter((m) => m.kind === "photo")).toHaveLength(1);
    expect(media.old).toBeUndefined();
    expect(media.l).toEqual({ kind: "logo", uri: "data:image/png;base64,BB" });
  });

  it("removes only the photo, and clears media when nothing is left", () => {
    expect(withPhoto({ p: { kind: "photo", uri: "data:x" }, s: { kind: "sound", uri: "data:y" } }, null)).toEqual({ s: { kind: "sound", uri: "data:y" } });
    expect(withPhoto({ p: { kind: "photo", uri: "data:x" } }, null)).toBeNull();
  });

  it("is read back by contactPhoto", () => {
    const card = { id: "c1", media: withPhoto(undefined, photo) } as unknown as ContactCard;
    expect(contactPhoto(card, "a1")).toBe(photo.dataUrl);
  });
});
