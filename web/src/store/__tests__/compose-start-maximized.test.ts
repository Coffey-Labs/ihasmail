import { beforeEach, describe, expect, it } from "vitest";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";

/**
 * "Open the composer full screen" (#401): the size a new composer starts at.
 *
 * Only new composers follow it. A draft put back after an undone or failed
 * send keeps the size it had, since that is the window somebody was already
 * looking at.
 */

beforeEach(() => {
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useMail.setState({ accountId: "a1", identities: [] as never });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
});

const opened = () => {
  const key = useCompose.getState().open();
  return useCompose.getState().drafts.find((d) => d.key === key)!;
};

describe("the size a new composer opens at", () => {
  it("is the usual window by default", () => {
    expect(opened().maximized).toBe(false);
  });

  it("is full screen with the setting on", () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, composeMaximized: true } }));
    expect(opened().maximized).toBe(true);
  });

  it("can still be restored to a window once open", () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, composeMaximized: true } }));
    const d = opened();
    useCompose.getState().update(d.key, { maximized: false });
    expect(useCompose.getState().drafts.find((x) => x.key === d.key)!.maximized).toBe(false);
  });
});
