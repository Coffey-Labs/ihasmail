import { describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { countMembers, createGroup, destroyGroup, groupRoleKey, groupRolesFromKey, membershipPatch } from "@/lib/admin/adminGroups";

describe("group membership", () => {
  it("is a patch to each member, one pointer each, so no other membership moves", () => {
    // Stalwart's set patch adds a key on `true` and removes it on `null`, and
    // leaves every other key in the set as it was.
    expect(membershipPatch(["u1", "u2"], "g1", true)).toEqual({ u1: { "memberGroupIds/g1": true }, u2: { "memberGroupIds/g1": true } });
    expect(membershipPatch(["u1"], "g1", false)).toEqual({ u1: { "memberGroupIds/g1": null } });
  });

  it("counts members as users whose memberships name the group, asking for no ids", async () => {
    const call = vi.spyOn(client, "call").mockResolvedValue({ ids: [], total: 4 });
    expect(await countMembers(["g1"])).toEqual(new Map([["g1", 4]]));
    expect(call).toHaveBeenCalledWith("x:Account/query", { filter: { "@type": "User", memberGroupIds: "g1" }, limit: 0, calculateTotal: true });
    call.mockRestore();
  });

  it("leaves a count out rather than showing a failed one as none", async () => {
    const call = vi.spyOn(client, "call").mockRejectedValue(new Error("offline"));
    expect(await countMembers(["g1"])).toEqual(new Map());
    call.mockRestore();
  });
});

describe("creating and deleting a group", () => {
  it("creates an account of type Group, with nothing a person needs to sign in", async () => {
    const call = vi.spyOn(client, "call").mockResolvedValue({ created: { n: { id: "g9" } } });
    expect(await createGroup({ name: " sales ", domainId: "d1", description: "", roles: { "@type": "Default" }, diskQuotaBytes: null })).toBe("g9");
    const create = (call.mock.calls[0]![1] as { create: { n: Record<string, unknown> } }).create.n;
    expect(create).toMatchObject({ "@type": "Group", name: "sales", domainId: "d1", description: null, roles: { "@type": "Default" }, permissions: { "@type": "Inherit" }, quotas: {} });
    expect(create).not.toHaveProperty("credentials");
    expect(create).not.toHaveProperty("encryptionAtRest");
    expect(create).not.toHaveProperty("memberGroupIds");
    call.mockRestore();
  });

  it("takes the members out before deleting, and deletes nothing if that fails", async () => {
    const call = vi.spyOn(client, "call").mockResolvedValueOnce({ updated: { u1: null } }).mockResolvedValueOnce({ destroyed: ["g1"] });
    await destroyGroup("g1", ["u1"]);
    expect(call.mock.calls.map((c) => [c[0], Object.keys(c[1] as object)])).toEqual([
      ["x:Account/set", ["update"]],
      ["x:Account/set", ["destroy"]],
    ]);
    call.mockReset();
    call.mockResolvedValueOnce({ notUpdated: { u1: { type: "forbidden" } } });
    await expect(destroyGroup("g1", ["u1"])).rejects.toMatchObject({ type: "forbidden" });
    expect(call).toHaveBeenCalledTimes(1);
    call.mockRestore();
  });

  it("goes straight to the delete for a group with no members", async () => {
    const call = vi.spyOn(client, "call").mockResolvedValue({ destroyed: ["g1"] });
    await destroyGroup("g1", []);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("x:Account/set", { destroy: ["g1"] });
    call.mockRestore();
  });

  it("round-trips a group's roles, which are Default or Custom", () => {
    for (const roles of [{ "@type": "Default" } as const, { "@type": "Custom", roleIds: { r1: true, r2: true } } as const]) {
      expect(groupRolesFromKey(groupRoleKey(roles))).toEqual(roles);
    }
  });
});
