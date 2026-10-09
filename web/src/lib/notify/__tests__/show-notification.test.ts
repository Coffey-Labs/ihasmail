import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showNotification } from "@/lib/notify/notify";

/**
 * The Settings test button runs in a visible, focused tab, which is exactly
 * when a new-mail notification is held back. It has to show anyway (#48).
 */
describe("showNotification", () => {
  const shown = vi.fn();

  beforeEach(() => {
    shown.mockClear();
    class FakeNotification {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string) {
        shown(title);
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("holds back new mail in a tab you are looking at", () => {
    showNotification("New mail");
    expect(shown).not.toHaveBeenCalled();
  });

  it("shows a forced one in that same tab", () => {
    showNotification("ihasmail test", { force: true });
    expect(shown).toHaveBeenCalledWith("ihasmail test");
  });

  it("still shows nothing without permission, forced or not", () => {
    (Notification as unknown as { permission: string }).permission = "denied";
    showNotification("ihasmail test", { force: true });
    expect(shown).not.toHaveBeenCalled();
  });
});
