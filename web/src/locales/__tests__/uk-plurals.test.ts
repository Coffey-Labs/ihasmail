import { describe, expect, it, afterEach } from "vitest";
import { plural, setCatalog } from "@/lib/i18n";
import { catalog as uk } from "@/locales/uk";

/**
 * Ukrainian needs `few` and `many` where English has one plural, and the rule
 * is not "n === 1": 11 is `many` despite ending in 1, and 21 is `one` again.
 * English's two-form assumption would render "5 лист", which is the kind of
 * wrong that makes a translation read as machine output whatever the
 * vocabulary is.
 */
const FORMS = { one: "{n} message", other: "{n} messages" };
afterEach(() => setCatalog("en", { strings: {}, plurals: {} }));

describe("Ukrainian plurals", () => {
  it("picks one, few and many by the language's own rule", () => {
    setCatalog("uk", uk);
    expect(plural(1, FORMS)).toBe("1 лист");
    expect(plural(2, FORMS)).toBe("2 листи");
    expect(plural(4, FORMS)).toBe("4 листи");
    expect(plural(5, FORMS)).toBe("5 листів");
    expect(plural(11, FORMS)).toBe("11 листів");   // many, despite ending in 1
    expect(plural(21, FORMS)).toBe("21 лист");     // one again
    expect(plural(0, FORMS)).toBe("0 листів");
  });

  it("carries every form for each counted string it ships", () => {
    // A missing `few` falls back to `other` silently, and is grammatical often
    // enough to go unnoticed while being wrong the rest of the time.
    for (const [key, forms] of Object.entries(uk.plurals)) {
      for (const cat of ["one", "few", "many", "other"] as const) {
        expect(forms[cat], `${key} is missing "${cat}"`).toBeTruthy();
      }
    }
  });
});
