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

/**
 * Issue #76, second round. The transport fault is fixed in the blob proxy, but
 * the save path had no answer for a script that arrives *partly* read: it is
 * neither unknown nor empty, so the guards above all pass it through. It parses
 * into a shorter rule list that looks exactly like a script with fewer rules,
 * and saving writes that shorter version back over the real one.
 *
 * These pin the third state: read, but not all of it.
 */
describe("a script that was only partly read", () => {
  /** Cut at 384 bytes, the way a compressing hop cut the reporter's script. */
  const truncate = (content: string, at: number) => content.slice(0, at);
  const full = rulesToSieve(threeRules);

  it("reports its rules as unknown rather than handing back the ones that parsed", () => {
    useSieve.setState({ contents: { s1: truncate(full, 384) } });
    const { rules, loaded, damage } = useSieve.getState().rules();
    expect(rules).toBeNull();
    expect(loaded).toBe(true);
    expect(damage).toBeTruthy();
  });

  it("refuses to save over the part it never saw", async () => {
    useSieve.setState({ contents: { s1: truncate(full, 384) } });
    await expect(useSieve.getState().saveRules([newRule({ name: "New" })])).rejects.toThrow(/overwrite the rest of it/i);
  });

  it("catches a cut at every offset through the script, not just a lucky one", () => {
    // The offsets that cannot be caught are the ends of complete rule blocks:
    // each is a valid shorter script and nothing in the bytes says otherwise.
    // That is the residual the proxy fix covers and this check cannot.
    const safe = new Set<number>();
    for (let n = 0; n <= threeRules.length; n++) safe.add(rulesToSieve(threeRules.slice(0, n)).length);
    let missed = 0;
    for (let at = 1; at < full.length; at++) {
      useSieve.setState({ contents: { s1: truncate(full, at) } });
      const { damage } = useSieve.getState().rules();
      if (!damage && !safe.has(at)) missed++;
    }
    expect(missed).toBe(0);
  });

  it("leaves an intact script alone at every length it can legitimately have", () => {
    for (let n = 0; n <= threeRules.length; n++) {
      useSieve.setState({ contents: { s1: rulesToSieve(threeRules.slice(0, n)) } });
      const { rules, damage } = useSieve.getState().rules();
      expect(damage).toBeNull();
      expect(rules).toHaveLength(n);
    }
  });

  it("leaves the shapes a rule can take alone — disabled, many actions, extensions", () => {
    // A false positive here costs someone the use of the rules editor, so the
    // walk has to pass everything rulesToSieve can legitimately produce.
    const varied = [
      newRule({ name: "Disabled", enabled: false }),
      newRule({ name: "Many actions", actions: [{ type: "fileinto", mailbox: "A" }, { type: "markread" }, { type: "flag" }, { type: "stop" }] }),
      newRule({ name: "Two tests", join: "anyof", tests: [{ type: "body", op: "contains", value: "x" }, { type: "size", op: "over", value: 1024 }] }),
      newRule({ name: "No actions at all", actions: [] }),
      newRule({ name: "Quotes \" and \\ backslash" }),
    ];
    useSieve.setState({ contents: { s1: rulesToSieve(varied) } });
    const { rules, damage } = useSieve.getState().rules();
    expect(damage).toBeNull();
    expect(rules).toHaveLength(varied.length);
  });

  it("catches a cut at every offset through that script too", () => {
    const varied = [newRule({ name: "Disabled", enabled: false }), newRule({ name: "Live" }), newRule({ name: "Also off", enabled: false })];
    const full = rulesToSieve(varied);
    const safe = new Set<number>();
    for (let n = 0; n <= varied.length; n++) safe.add(rulesToSieve(varied.slice(0, n)).length);
    let missed = 0;
    for (let at = 1; at < full.length; at++) {
      useSieve.setState({ contents: { s1: full.slice(0, at) } });
      if (!useSieve.getState().rules().damage && !safe.has(at)) missed++;
    }
    expect(missed).toBe(0);
  });

  it("does not call a hand-written script damaged", () => {
    useSieve.setState({ contents: { s1: 'require ["fileinto"];\nif header :contains "from" "x" { fileinto "X"; }' } });
    const { rules, damage } = useSieve.getState().rules();
    expect(damage).toBeNull();
    expect(rules).toBeNull(); // hand-written, which is a different refusal
  });
});
