import { describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { aliasList, describeDirectoryError, DirectoryError, hasPassword, passwordPatch, queryAccounts, quotasWithDisk } from "@/lib/adminDirectory";

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
