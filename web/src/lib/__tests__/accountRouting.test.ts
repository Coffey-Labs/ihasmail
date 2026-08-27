import { describe, expect, it } from "vitest";
import { accountForCapability, ownAccountForCapability, type SessionLike } from "@/lib/accountRouting";

/**
 * Found by sharing a folder between two real accounts.
 *
 * Switching to the account somebody shared pointed everything at it, because
 * the rule was "use the selected account if it can do this" and a shared file
 * account can, by definition, do files. ihasmail keeps its own settings in the
 * account's Files, so changing any setting while looking at somebody's shared
 * folder wrote `settings.json` into *their* storage, creating the `ihasmail`
 * folder there to do it. Reading someone else's data by mistake is bad; writing
 * yours into it is worse, and it was the same one-line rule doing both.
 */

const CAL = "urn:ietf:params:jmap:calendars";
const FILES = "urn:ietf:params:jmap:filenode";
const MAIL = "urn:ietf:params:jmap:mail";

/** Mine does everything; theirs is a shared account with only files on it. */
const shared = (): SessionLike => ({
  accounts: {
    mine: { isPersonal: true, accountCapabilities: { [MAIL]: {}, [FILES]: {}, [CAL]: {} } },
    theirs: { isPersonal: false, accountCapabilities: { [FILES]: {} } },
  },
  primaryAccounts: { [MAIL]: "mine", [FILES]: "mine", [CAL]: "mine" },
});

describe("what the reader is looking at", () => {
  it("follows the switch into a shared account for what was shared", () => {
    expect(accountForCapability(shared(), "theirs", FILES)).toBe("theirs");
  });

  it("leaves everything else on the reader's own account", () => {
    expect(accountForCapability(shared(), "theirs", MAIL)).toBe("mine");
    expect(accountForCapability(shared(), "theirs", CAL)).toBe("mine");
  });

  it("still follows a switch between the reader's own accounts", () => {
    const s = shared();
    s.accounts.second = { isPersonal: true, accountCapabilities: { [MAIL]: {} } };
    expect(accountForCapability(s, "second", MAIL)).toBe("second");
  });

  it("gives up rather than aim at a shared account for something unshared", () => {
    // No primary for calendars, and theirs does not offer them. The old rule
    // fell back to the selection, which is somebody else's account.
    const s = shared();
    delete s.primaryAccounts[CAL];
    expect(accountForCapability(s, "theirs", CAL)).toBeNull();
  });

  it("lets one of the reader's own accounts stand in when there is no primary", () => {
    const s = shared();
    delete s.primaryAccounts[CAL];
    expect(accountForCapability(s, "mine", CAL)).toBe("mine");
  });
});

describe("what belongs to the reader", () => {
  it("stays on their own account while they look at a shared one", () => {
    // The one that matters: settings are written through this.
    expect(ownAccountForCapability(shared(), FILES)).toBe("mine");
  });

  it("ignores a primary account the server says is not the reader's", () => {
    const s = shared();
    s.primaryAccounts[FILES] = "theirs";
    expect(ownAccountForCapability(s, FILES)).toBe("mine");
  });

  it("finds a personal account when no primary is named", () => {
    const s = shared();
    delete s.primaryAccounts[FILES];
    expect(ownAccountForCapability(s, FILES)).toBe("mine");
  });

  it("answers nothing rather than a shared account", () => {
    const s: SessionLike = {
      accounts: { theirs: { isPersonal: false, accountCapabilities: { [FILES]: {} } } },
      primaryAccounts: {},
    };
    expect(ownAccountForCapability(s, FILES)).toBeNull();
  });
});
