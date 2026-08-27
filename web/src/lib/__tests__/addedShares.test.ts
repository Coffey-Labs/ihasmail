import { describe, expect, it } from "vitest";

/**
 * Whether a shared collection counts as added.
 *
 * JMAP keeps this on the collection, in `isSubscribed`, and that is the better
 * place: a preference the server holds is one every client sees. But
 * subscribing writes to the *owner's* account, and Stalwart 0.16.19 refuses
 * that for an address book shared read-only — "You are not allowed to modify
 * this address book" — while accepting the identical write on a shared
 * calendar. Confirmed against the live server on 2026-08-27, from a second
 * account holding the share.
 *
 * So there are two records and either counts. The rule is the whole of the
 * fix, which is why it is worth pinning down here rather than leaving it
 * spelled out in three components that could drift apart.
 */

const key = (accountId: string, id: string) => `${accountId}:${id}`;

/** Added if the server remembered it, or the reader's settings did. */
function isAdded(collection: { accountId: string; id: string; isSubscribed?: boolean }, addedShares: string[]): boolean {
  return Boolean(collection.isSubscribed) || new Set(addedShares).has(key(collection.accountId, collection.id));
}

const book = (over: Partial<{ accountId: string; id: string; isSubscribed: boolean }> = {}) =>
  ({ accountId: "acct", id: "ab1", ...over });

describe("whether a shared collection has been added", () => {
  it("is added when the server took the subscription", () => {
    expect(isAdded(book({ isSubscribed: true }), [])).toBe(true);
  });

  it("is added when only the settings remember it", () => {
    // The address book case: the server refused the write.
    expect(isAdded(book(), ["acct:ab1"])).toBe(true);
  });

  it("is not added when neither says so", () => {
    expect(isAdded(book(), [])).toBe(false);
    expect(isAdded(book(), ["other:ab1", "acct:ab2"])).toBe(false);
  });
});

describe("keys are account-qualified", () => {
  it("does not confuse the same id in another account", () => {
    // Two accounts each having a book "ab1" is ordinary, not unlucky.
    expect(isAdded(book({ accountId: "theirs" }), ["mine:ab1"])).toBe(false);
  });

  it("distinguishes two collections in one account", () => {
    expect(isAdded(book({ id: "ab2" }), ["acct:ab1"])).toBe(false);
  });
});
