import { describe, expect, it } from "vitest";
import { permissionSet } from "@/lib/admin/adminAccess";
import { canBuildOn, effectivePermissions, inherited, roleOutranks, setPatch, type DirectoryRole } from "@/lib/admin/adminRoles";

const flags = (...n: string[]) => Object.fromEntries(n.map((x) => [x, true]));
const roles = new Map<string, DirectoryRole>([
  ["user", { id: "user", description: "User", enabledPermissions: flags("jmapEmailGet", "jmapEmailUpdate") }],
  ["help", { id: "help", description: "Helpdesk", enabledPermissions: flags("sysAccountGet"), disabledPermissions: flags("jmapEmailUpdate"), roleIds: flags("user") }],
  ["lead", { id: "lead", description: "Lead", enabledPermissions: flags("sysAccountUpdate"), roleIds: flags("help") }],
]);

describe("what a role holds", () => {
  it("follows every base, and a denial anywhere in the tree wins", () => {
    // Stalwart unions enabled with enabled and disabled with disabled across
    // the tree, then takes the disabled away (permissions.rs).
    expect([...effectivePermissions(roles.get("lead")!, roles, "lead")].sort()).toEqual(["jmapEmailGet", "sysAccountGet", "sysAccountUpdate"]);
    const { granted, denied } = inherited(["help"], roles, "lead");
    expect(granted.get("jmapEmailGet")).toBe("help");
    expect(denied.get("jmapEmailUpdate")).toBe("help");
  });

  it("changes a set one pointer at a time", () => {
    expect(setPatch("enabledPermissions", ["a", "b"], new Set(["b", "c"]))).toEqual({ "enabledPermissions/a": null, "enabledPermissions/c": true });
    expect(setPatch("roleIds", [], [])).toEqual({});
  });

  it("will not build on itself, or on a role already built on it", () => {
    expect(canBuildOn("help", "help", roles)).toBe(false);
    expect(canBuildOn("help", "lead", roles)).toBe(false);
    expect(canBuildOn("lead", "user", roles)).toBe(true);
    expect(canBuildOn(null, "lead", roles)).toBe(true);
  });

  it("is read-only to a viewer missing anything enabled in its tree, denied or not", () => {
    const viewer = permissionSet(["jmapEmailGet", "sysAccountGet", "sysAccountUpdate"]);
    // jmapEmailUpdate is denied on Helpdesk but enabled on User beneath it: a
    // grant Stalwart would check, and a delete it would not.
    expect(roleOutranks(viewer, roles.get("lead")!, roles)).toBe(true);
    expect(roleOutranks(permissionSet([...viewer, "jmapEmailUpdate"]), roles.get("lead")!, roles)).toBe(false);
  });
});
