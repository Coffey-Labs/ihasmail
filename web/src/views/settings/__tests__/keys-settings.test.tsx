import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToasts } from "@/ui/toast";
import type { PublicKey } from "@/lib/publicKeys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The store tests cover reading a key without parsing one. What they cannot
 * reach is the thing this section exists to get right: when the server refuses
 * a key it says exactly what is wrong with it, and that sentence has to arrive
 * in front of the person who pasted it, with what they pasted still on screen.
 * A component that swallowed the message and cleared the box would pass every
 * assertion in publicKeys.test.ts.
 */
let available = true;
let keys: PublicKey[] = [];
let addError: string | null = null;
const added = vi.fn();

vi.mock("@/lib/publicKeys", async (orig) => {
  const real = await orig<typeof import("@/lib/publicKeys")>();
  return {
    ...real,
    publicKeysAvailable: () => available,
    listPublicKeys: async () => keys,
    addPublicKey: async (key: string, description: string) => {
      if (addError) throw new Error(addError);
      added(key, description);
      return { id: "pk1", key, description, createdAt: null, expiresAt: null, emailAddresses: [] };
    },
    updatePublicKey: async () => {},
    removePublicKey: async () => {},
  };
});

const { KeysSettings } = await import("../KeysSettings");

const key = (over: Partial<PublicKey> = {}): PublicKey => ({
  id: "k1",
  key: "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmDMEZabcdefghijklmnopqrstuvwxyz0123456789\n-----END PGP PUBLIC KEY BLOCK-----",
  description: "Work key",
  createdAt: "2026-09-01T10:00:00Z",
  expiresAt: null,
  emailAddresses: [],
  ...over,
});

describe("Encryption keys", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => {
      root.render(<KeysSettings />);
    });
  };

  beforeEach(() => {
    available = true;
    keys = [];
    addError = null;
    added.mockClear();
    useToasts.setState({ toasts: [] });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const type = async (el: HTMLTextAreaElement | HTMLInputElement, value: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    await act(async () => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const click = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("says the server does not offer the registry, rather than showing no keys", async () => {
    available = false;
    await render();
    expect(host.textContent).toContain("Not available on this server");
    expect(host.textContent).not.toContain("No keys yet");
  });

  it("shows the server's own complaint and keeps what was pasted", async () => {
    // Verbatim from a live Stalwart rejecting a block that was not OpenPGP.
    addError = "Failed to decode OpenPGP public key: Malformed packet: Malformed CTB: MSB of ptag not set.";
    await render();

    await click([...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Add a key"))!);
    const body = host.querySelector("#key-body") as HTMLTextAreaElement;
    await type(body, "not a key at all");
    await click([...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Add key"))!);

    const shown = useToasts.getState().toasts;
    expect(shown.at(-1)?.kind).toBe("error");
    expect(shown.at(-1)?.message).toBe(addError);
    // The form is still filled in: retyping a key block by hand is the one
    // thing a rejection must not cost.
    expect((host.querySelector("#key-body") as HTMLTextAreaElement).value).toBe("not a key at all");
  });

  it("labels the kind from the armour header", async () => {
    keys = [key(), key({ id: "k2", key: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----", description: "Corporate" })];
    await render();
    const chips = [...host.querySelectorAll(".chip")].map((c) => c.textContent);
    expect(chips).toContain("OpenPGP");
    expect(chips).toContain("S/MIME");
  });

  it("renames through an input with an accessible name, not a bare heading", async () => {
    keys = [key()];
    await render();
    await click(host.querySelector("h3")!);
    const input = host.querySelector('input[aria-label="Key description"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("Work key");
  });

  it("labels a key with no description rather than showing an empty heading", async () => {
    keys = [key({ description: "" })];
    await render();
    expect(host.querySelector("h3")?.textContent).toBe("Untitled key");
  });

  it("sends an empty description as empty, so no English is stored on the server", async () => {
    await render();
    await click([...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Add a key"))!);
    await type(host.querySelector("#key-body") as HTMLTextAreaElement, "-----BEGIN PGP PUBLIC KEY BLOCK-----\nx\n-----END PGP PUBLIC KEY BLOCK-----");
    await click([...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Add key"))!);
    expect(added).toHaveBeenCalledWith(expect.stringContaining("BEGIN PGP"), "");
  });
});
