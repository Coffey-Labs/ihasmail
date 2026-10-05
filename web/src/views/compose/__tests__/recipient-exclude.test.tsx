import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecipientInput } from "../RecipientInput";
import { useContacts } from "@/store/contacts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * Someone already in Cc was still offered when typing in To, so it was easy
 * to address the same person twice from two fields.
 */

describe("suggestions across To, Cc and Bcc", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useContacts.setState({
      suggest: (async () => [
        { name: "Ann Lee", email: "ann@example.org", source: "contact" },
        { name: "Ann Taylor", email: "ataylor@example.org", source: "contact" },
      ]) as never,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("leaves out an address already in another recipient field", async () => {
    await act(async () => {
      root.render(<RecipientInput value={[]} exclude={[{ name: null, email: "ANN@example.org" }]} onChange={() => {}} />);
    });
    const input = host.querySelector("input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "ann");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    const offered = host.textContent ?? "";
    expect(offered).toContain("ataylor@example.org");
    expect(offered).not.toContain("ann@example.org");
  });
});
