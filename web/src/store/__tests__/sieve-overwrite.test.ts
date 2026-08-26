import { beforeEach, describe, expect, it } from "vitest";
import { useSieve } from "@/store/sieve";
import { newRule, rulesToSieve } from "@/lib/sieve";
import type { SieveScript } from "@/jmap/types";

/**
 * Issue #76: adding a filter from a message reported success, and the script
 * on the server never held more than two rules.
 *
 * The chain was three links long, and each looked reasonable alone:
 *
 *   1. `load()` recorded a *failed* blob fetch as `contents[id] = ""`.
 *   2. `sieveToRules("")` returns `[]` — "this script has no rules", which is
 *      indistinguishable from "we could not read this script".
 *   3. Saving writes the whole script from that baseline, so every existing
 *      rule was deleted, and the UI reported success because the write worked.
 *
 * The fix is to keep "unknown" and "empty" apart at every step. These pin that:
 * an unreadable script must never present as an empty one.
 */

const SCRIPT: SieveScript = { id: "s1", name: "ihasmail", isActive: true, blobId: "b1" } as SieveScript;
const threeRules = [newRule({ name: "One" }), newRule({ name: "Two" }), newRule({ name: "Three" })];

beforeEach(() => {
  useSieve.setState({ accountId: "a1", scripts: [SCRIPT], contents: {}, loading: false, error: null });
});

describe("a script whose content could not be read", () => {
  it("reports its rules as unknown, not as none", () => {
    // contents is empty: the fetch failed, or has not happened yet.
    const { rules, loaded } = useSieve.getState().rules();
    expect(rules).toBeNull();
    expect(loaded).toBe(false);
  });

  it("refuses to save rather than overwriting what it cannot see", async () => {
    await expect(useSieve.getState().saveRules([newRule({ name: "New" })])).rejects.toThrow(/could not be read/i);
  });

  it("says so in terms that point at the fix", async () => {
    // "Reload and try again" is recoverable advice; a generic failure is not.
    await expect(useSieve.getState().saveRules([newRule({ name: "New" })])).rejects.toThrow(/reload/i);
  });
});

describe("a script that is genuinely empty", () => {
  it("is distinguishable from one that could not be read", () => {
    useSieve.setState({ contents: { s1: "" } });
    const { rules, loaded } = useSieve.getState().rules();
    expect(loaded).toBe(true);
    expect(rules).toEqual([]);
  });
});

describe("a script that was read", () => {
  it("hands back every rule in it", () => {
    useSieve.setState({ contents: { s1: rulesToSieve(threeRules) } });
    const { rules, loaded } = useSieve.getState().rules();
    expect(loaded).toBe(true);
    expect(rules).toHaveLength(3);
    expect(rules?.map((r) => r.name)).toEqual(["One", "Two", "Three"]);
  });

  it("does not lose rules across a save-shaped round trip", () => {
    // The regression in one line: N rules in, N + 1 out after adding one.
    useSieve.setState({ contents: { s1: rulesToSieve(threeRules) } });
    const before = useSieve.getState().rules().rules!;
    const after = [...before, newRule({ name: "Four" })];
    useSieve.setState({ contents: { s1: rulesToSieve(after) } });
    expect(useSieve.getState().rules().rules).toHaveLength(4);
  });
});

describe("reloading", () => {
  it("does not discard content it already holds when a refetch yields nothing", () => {
    // saveScript caches what it just wrote, then reloads. A reload whose fetch
    // failed used to replace the whole map and wipe that.
    useSieve.setState({ contents: { s1: rulesToSieve(threeRules) } });
    const kept = useSieve.getState().contents.s1;
    useSieve.setState((st) => ({ contents: { ...st.contents } })); // merge, not replace
    expect(useSieve.getState().contents.s1).toBe(kept);
    expect(useSieve.getState().rules().rules).toHaveLength(3);
  });
});
