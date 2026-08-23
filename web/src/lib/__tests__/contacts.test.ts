import { describe, expect, it } from "vitest";
import { contactFromAddress, nameParts } from "../contacts";
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
