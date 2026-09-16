import { describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { aliasList, describeDirectoryError, DirectoryError, hasPassword, passwordPatch, queryAccounts, quotasWithDisk } from "@/lib/admin/adminDirectory";

describe("setting a password", () => {
  it("writes into the existing password credential, keeping its place", () => {
    const account = { credentials: { "0": { "@type": "AppPassword" as const }, "2": { "@type": "Password" as const, secret: "[********]" } } };
    expect(passwordPatch(account, "new secret")).toEqual({ "credentials/2/secret": "new secret" });
  });

  it("adds one after the last index when the account has none", () => {
    const account = { credentials: { "0": { "@type": "AppPassword" as const }, "3": { "@type": "ApiKey" as const } } };
    expect(passwordPatch(account, "s")).toEqual({ "credentials/4": { "@type": "Password", secret: "s" } });
    expect(passwordPatch({}, "s")).toEqual({ "credentials/0": { "@type": "Password", secret: "s" } });
    expect(hasPassword(account)).toBe(false);
  });
});

describe("lists written back", () => {
  it("re-index aliases the way the server stores a list", () => {
    expect(aliasList([{ name: "b", domainId: "d1" }, { name: "c", domainId: "d2", enabled: false }])).toEqual({
      "0": { enabled: true, name: "b", domainId: "d1", description: null },
      "1": { enabled: false, name: "c", domainId: "d2", description: null },
    });
  });

  it("change the disk limit without touching the other quotas", () => {
    expect(quotasWithDisk({ maxEmails: 10, maxDiskQuota: 5 }, 7)).toEqual({ maxEmails: 10, maxDiskQuota: 7 });
    expect(quotasWithDisk({ maxEmails: 10, maxDiskQuota: 5 }, null)).toEqual({ maxEmails: 10 });
    expect(quotasWithDisk(undefined, 0)).toEqual({});
  });
});

describe("explaining a refusal", () => {
  it("says what a taken address means", () => {
    expect(describeDirectoryError(new DirectoryError("primaryKeyViolation", "exists"))).toMatch(/already in use/);
  });

  it("keeps the server's own words for a password policy", () => {
    expect(describeDirectoryError(new DirectoryError("invalidProperties", "Password must be at least 8 characters long.", ["secret"]))).toContain("at least 8 characters");
  });

  it("handles a method-level refusal as well as a set error", () => {
    expect(describeDirectoryError({ type: "forbidden", message: "x:Account/set: forbidden" })).toMatch(/refused/);
  });
});

describe("the account query", () => {
  it("filters on @type, the property's name on the object", async () => {
    // A live 0.16 server answers a plain `type` with "unsupportedFilter - type"
    // and fails the whole list, which is how this was found.
    const call = vi.spyOn(client, "call").mockResolvedValue({ ids: [], total: 0 });
    await queryAccounts({ type: "User", text: " ada ", position: 50, limit: 50 });
    expect(call).toHaveBeenCalledWith("x:Account/query", { filter: { "@type": "User", text: "ada" }, position: 50, limit: 50, calculateTotal: true });
    call.mockRestore();
  });
});

/**
 * Stalwart explains a refusal in English, and none of it should reach an
 * interface in another language as it is. Each case below is a refusal a
 * live server gave, or one its source says it gives.
 */
describe("refusals in the reader's language", () => {
  it("recognizes the registry's validators and says it again, without the server's words", () => {
    // Live, 2026-09-13: a reserved TLD, and a catch-all without a domain.
    const domain = describeDirectoryError(new DirectoryError("invalidPatch", "Invalid domain name", ["name"]), "domain");
    expect(domain).toMatch(/isn't a valid domain name/);
    expect(domain).not.toContain("Invalid domain name");
    expect(describeDirectoryError(new DirectoryError("invalidPatch", "Invalid email address", ["catchAllAddress"]), "domain")).toMatch(/full address/);
    expect(describeDirectoryError(new DirectoryError("invalidProperties", "Invalid email local part", ["name"]))).toMatch(/before the @/);
  });

  it("never echoes a description it does not know", () => {
    const text = describeDirectoryError(new DirectoryError("invalidPatch", "Something only the server would say", ["whatever"]));
    expect(text).not.toContain("Something only the server would say");
    expect(describeDirectoryError(new DirectoryError("forbidden", "You are not allowed to do that thing"))).not.toContain("not allowed to do that thing");
    expect(describeDirectoryError(new DirectoryError("someNewType", "Brand new English"))).not.toContain("Brand new English");
  });

  it("tells a grant refusal and a directory-backed account apart from a plain no", () => {
    expect(describeDirectoryError(new DirectoryError("forbidden", "You are not authorized to grant permissions: sysDomainDestroy."))).toMatch(/permissions your own role/);
    expect(describeDirectoryError(new DirectoryError("forbidden", "Cannot set credentials for accounts in an external directory."))).toMatch(/external directory/);
  });

  it("words a clash and a missing object for what it was about", () => {
    expect(describeDirectoryError(new DirectoryError("primaryKeyViolation", undefined, ["name"]), "domain")).toMatch(/domain name is already in use/);
    expect(describeDirectoryError(new DirectoryError("primaryKeyViolation", undefined))).toMatch(/address is already in use/);
    expect(describeDirectoryError(new DirectoryError("notFound", undefined), "domain")).toMatch(/domain no longer exists/);
  });

  it("explains ihasmail's own refusals by their code, not their English message", () => {
    const own = { status: 403, code: "administration_needs_own_device", message: "Administration is only available when signed in on a device marked as your own (x:Account/query)." };
    expect(describeDirectoryError(own)).toMatch(/marked as your own/);
    expect(describeDirectoryError(own)).not.toContain("x:Account/query");
    expect(describeDirectoryError({ status: 403, code: "administration_disabled", message: "…" })).toMatch(/turned off/);
    expect(describeDirectoryError({ method: "x:Account/query", type: "unsupportedFilter", message: "x:Account/query: unsupportedFilter - type" })).toBe("The mail server could not carry out the request (unsupportedFilter).");
  });
});
