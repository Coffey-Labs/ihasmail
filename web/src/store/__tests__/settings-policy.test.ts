import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import { isEnforced, policyDefaults, policyEnforced, resetSettingsPolicyForTest } from "@/lib/settingsPolicy";

/*
 * Settings an installation decides, from #207.
 *
 * A school turning on "warn about outside senders" for three thousand pupils
 * cannot ask three thousand pupils. Two powers, and the difference between them
 * is the whole point: defaults are a starting point the reader may change,
 * enforced settings are not.
 */

vi.mock("@/lib/settingsSync", () => ({
  queueSettingsPush: vi.fn(),
  pendingSettingsKeys: () => new Set<string>(),
}));

beforeEach(() => {
  resetSettingsPolicyForTest();
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
});

afterEach(() => {
  resetSettingsPolicyForTest();
  vi.restoreAllMocks();
});

describe("what the installation has decided", () => {
  it("keeps to the settings this build actually has", () => {
    /*
     * A policy written against a newer ihasmail, or with a typo in it, must not
     * introduce a key nothing reads: it would be carried around and pushed to
     * the reader's settings file for ever. Same rule an imported settings file
     * already gets.
     */
    resetSettingsPolicyForTest({
      defaults: { conversationMode: false, notARealSetting: true } as never,
      enforced: { alsoNotReal: 1 } as never,
    });
    expect(policyDefaults()).toEqual({ conversationMode: false });
    expect(policyEnforced()).toEqual({});
  });

  it("says which settings belong to the administrator", () => {
    // The setting the issue was actually about: the outside-sender banner.
    resetSettingsPolicyForTest({ defaults: {}, enforced: { externalSenderBanner: true } as never });
    expect(isEnforced("externalSenderBanner")).toBe(true);
    expect(isEnforced("conversationMode")).toBe(false);
  });
});

describe("defaults, for an account that has none of its own", () => {
  it("seeds them", () => {
    resetSettingsPolicyForTest({ defaults: { conversationMode: false } as never, enforced: {} });
    useSettings.getState().seedFromPolicy();
    expect(useSettings.getState().settings.conversationMode).toBe(false);
  });

  it("leaves everything it does not name alone", () => {
    resetSettingsPolicyForTest({ defaults: { conversationMode: false } as never, enforced: {} });
    useSettings.getState().seedFromPolicy();
    expect(useSettings.getState().settings.showAvatars).toBe(DEFAULT_SETTINGS.showAvatars);
  });

  it("can still be changed afterwards, being a starting point and not a rule", () => {
    resetSettingsPolicyForTest({ defaults: { conversationMode: false } as never, enforced: {} });
    useSettings.getState().seedFromPolicy();
    useSettings.getState().update({ conversationMode: true });
    expect(useSettings.getState().settings.conversationMode).toBe(true);
  });

  it("does nothing at all when the installation has set none", () => {
    const before = useSettings.getState().settings;
    useSettings.getState().seedFromPolicy();
    expect(useSettings.getState().settings).toBe(before);
  });
});

describe("enforced settings, which the reader may not change", () => {
  beforeEach(() => {
    resetSettingsPolicyForTest({ defaults: {}, enforced: { conversationMode: true } as never });
  });

  it("survives an update that tries to change it", () => {
    useSettings.getState().update({ conversationMode: false });
    expect(useSettings.getState().settings.conversationMode).toBe(true);
  });

  it("does not stop the rest of that same update", () => {
    // The one key is refused; the others are the reader's business.
    useSettings.getState().update({ conversationMode: false, showAvatars: false });
    expect(useSettings.getState().settings.conversationMode).toBe(true);
    expect(useSettings.getState().settings.showAvatars).toBe(false);
  });

  it("survives a settings file arriving from another device", () => {
    // An older sign-in wrote past the policy before it existed. Hydrating must
    // not put that back.
    useSettings.getState().hydrate({ conversationMode: false, showAvatars: false });
    expect(useSettings.getState().settings.conversationMode).toBe(true);
    expect(useSettings.getState().settings.showAvatars).toBe(false);
  });

  it("survives a reset", () => {
    // Resetting must not be the way around a policy.
    useSettings.getState().reset();
    expect(useSettings.getState().settings.conversationMode).toBe(true);
  });

  it("survives an imported settings file", () => {
    useSettings.getState().importJson(JSON.stringify({ conversationMode: false }));
    expect(useSettings.getState().settings.conversationMode).toBe(true);
  });
});

describe("reset, where the installation has chosen defaults", () => {
  it("goes back to the installation's answer rather than to ihasmail's", () => {
    resetSettingsPolicyForTest({ defaults: { conversationMode: false } as never, enforced: {} });
    useSettings.getState().update({ conversationMode: true });
    useSettings.getState().reset();
    expect(useSettings.getState().settings.conversationMode).toBe(false);
  });
});
