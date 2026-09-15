import { describe, expect, it } from "vitest";
import source from "../../locales/permissions/source.json";
import { describePermissions, splitLabel, type PermissionCatalog } from "@/lib/permissionLabels";
import { UI_LANGUAGES } from "@/lib/languages";


describe("permission labels", () => {
  it("split Stalwart's label into its heading and action", () => {
    expect(splitLabel("Accounts Management: Create accounts")).toEqual({ categoryKey: "Accounts Management", action: "Create accounts" });
    expect(splitLabel("Action: Reload: TLS certificates")).toEqual({ categoryKey: "Action", action: "Reload: TLS certificates" });
    expect(splitLabel("Act on behalf of another user")).toEqual({ categoryKey: "General", action: "Act on behalf of another user" });
  });

  it("fall back to Stalwart's English for a permission a language does not have yet", () => {
    const catalog: PermissionCatalog = { categories: { "Accounts Management": "Kontenverwaltung" }, labels: { sysAccountGet: "Konten abrufen" } };
    expect(describePermissions([
      { name: "sysAccountGet", label: "Accounts Management: Get accounts" },
      { name: "sysBrandNewThing", label: "Novelties: Do something new" },
      { name: "impersonate", label: "Act on behalf of another user" },
    ], catalog, "Allgemein")).toEqual([
      { name: "sysAccountGet", categoryKey: "Accounts Management", category: "Kontenverwaltung", action: "Konten abrufen" },
      { name: "sysBrandNewThing", categoryKey: "Novelties", category: "Novelties", action: "Do something new" },
      { name: "impersonate", categoryKey: "General", category: "Allgemein", action: "Act on behalf of another user" },
    ]);
  });
});

/**
 * Every language covers every permission the snapshot has, and nothing it
 * does not: a missing one would show English in the middle of a translated
 * picker, and a stale one would never be looked up.
 */
describe("the permission catalogs", () => {
  const modules = import.meta.glob<{ permissionCatalog: PermissionCatalog }>("../../locales/permissions/*.ts");
  const tagOf = (path: string) => path.split("/").pop()!.replace(/\.ts$/, "");
  const languages = UI_LANGUAGES.map((l) => l.tag).filter((tag) => tag !== "en");
  const names = new Set(source.permissions.map((p) => p.name));
  const categories = new Set(source.permissions.map((p) => splitLabel(p.label).categoryKey).filter((c) => c !== "General"));

  it("exist for every language the interface ships", () => {
    expect(Object.keys(modules).map(tagOf).sort()).toEqual([...languages].sort());
  });

  for (const tag of languages) {
    it(`${tag} names every permission and heading, and nothing else`, async () => {
      const load = Object.entries(modules).find(([path]) => tagOf(path) === tag)?.[1];
      expect(load, `locales/permissions/${tag}.ts`).toBeTruthy();
      const { permissionCatalog } = await load!();
      expect(Object.keys(permissionCatalog.labels).filter((n) => !names.has(n))).toEqual([]);
      expect([...names].filter((n) => !permissionCatalog.labels[n]?.trim())).toEqual([]);
      expect(Object.keys(permissionCatalog.categories).sort()).toEqual([...categories].sort());
    });
  }
});
