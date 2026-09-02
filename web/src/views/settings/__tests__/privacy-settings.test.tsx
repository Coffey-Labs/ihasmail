import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrivacySettings } from "../PrivacySettings";
import { GeneralSettings } from "../GeneralSettings";
import { useSettings, DEFAULT_SETTINGS } from "@/store/settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The point of the section is that nothing was lost on the way out of General.
 * A setting that stops being reachable is still stored, still applied, and
 * impossible to change -- which is worse than leaving it where it was.
 */
describe("Privacy & safety", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async (el: React.ReactNode) => {
    await act(async () => {
      root.render(el);
    });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("offers every control that left General", async () => {
    await render(<PrivacySettings />);
    const text = host.textContent ?? "";
    expect(text).toContain("Remote images");
    expect(text).toContain("Always request read receipts");
    expect(text).toContain("When someone requests a read receipt");
    expect(text).toContain("Undo send window");
    expect(text).toContain("Attachment reminder");
    expect(text).toContain("Confirm before deleting");
  });

  it("leaves none of them behind in General", async () => {
    await render(<GeneralSettings />);
    const text = host.textContent ?? "";
    for (const gone of [
      "Remote images",
      "Always request read receipts",
      "When someone requests a read receipt",
      "Undo send window",
      "Attachment reminder",
      "Confirm before deleting",
    ]) {
      expect(text, `${gone} is in both sections`).not.toContain(gone);
    }
  });

  it("keeps General's own settings where they were", async () => {
    await render(<GeneralSettings />);
    const text = host.textContent ?? "";
    expect(text).toContain("Reading pane");
    expect(text).toContain("Conversation view");
    expect(text).toContain("Default format");
    expect(text).toContain("Spell check while typing");
  });

  it("writes through to the same stored settings the old controls used", async () => {
    await render(<PrivacySettings />);
    const select = [...host.querySelectorAll("select")].find((el) =>
      [...el.options].some((o) => o.value === "always"),
    );
    expect(select, "remote images select").toBeTruthy();
    await act(async () => {
      select!.value = "always";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(useSettings.getState().settings.imagePolicy).toBe("always");
  });

  it("hides the trusted-sender list until there is one", async () => {
    await render(<PrivacySettings />);
    expect(host.textContent).not.toContain("Always showing images from");

    await act(async () => {
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, trustedImageSenders: ["ada@example.com"] } });
    });
    await render(<PrivacySettings />);
    expect(host.textContent).toContain("Always showing images from");
    expect(host.textContent).toContain("ada@example.com");
  });

  it("removes a trusted sender, which nothing outside a message could do before", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, trustedImageSenders: ["ada@example.com", "bob@example.com"] } });
    await render(<PrivacySettings />);
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label*="ada@example.com"]');
    expect(remove, "remove button").toBeTruthy();
    await act(async () => {
      remove!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useSettings.getState().settings.trustedImageSenders).toEqual(["bob@example.com"]);
  });

  it("offers the three warnings, all switched off", async () => {
    await render(<PrivacySettings />);
    const text = host.textContent ?? "";
    expect(text).toContain("Mark messages from outside");
    expect(text).toContain("Ask before sending outside");
    expect(text).toContain("Ask before sending to a large group");
    expect(text).toContain("Ask before opening a link in a message");

    const s = useSettings.getState().settings;
    expect(s.externalSenderBanner).toBe(false);
    expect(s.externalRecipientConfirm).toBe(false);
    expect(s.externalLinkWarning).toBe(false);
    expect(s.replyAllThreshold).toBe(0);
  });

  it("hides each domain list until its warning is switched on", async () => {
    await render(<PrivacySettings />);
    expect(host.textContent).not.toContain("Also count these domains as inside");
    expect(host.textContent).not.toContain("Open links to these domains without asking");

    await act(async () => {
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, externalSenderBanner: true, externalLinkWarning: true } });
    });
    await render(<PrivacySettings />);
    expect(host.textContent).toContain("Also count these domains as inside");
    expect(host.textContent).toContain("Open links to these domains without asking");
  });

  it("normalises a typed domain, so the list holds something that can match", async () => {
    await act(async () => {
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, externalLinkWarning: true } });
    });
    await render(<PrivacySettings />);
    const input = host.querySelector<HTMLInputElement>('input.input');
    expect(input, "domain input").toBeTruthy();

    for (const [typed, stored] of [["@Example.com", "example.com"], ["ada@Partner.ORG", "partner.org"], ["https://third.net/path", "third.net"]]) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(input!, typed);
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      expect(useSettings.getState().settings.trustedLinkDomains).toContain(stored);
    }
  });
});
