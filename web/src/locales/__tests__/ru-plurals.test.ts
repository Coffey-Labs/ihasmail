import { describe, expect, it, afterEach } from "vitest";
import { plural, setCatalog } from "@/lib/i18n";
import { catalog as ru } from "@/locales/ru";

/**
 * Russian is the first shipped catalogue that needs `few` and `many`, so this
 * checks the real entries rather than a fixture. English would have rendered
 * "5 письмо" for all of these, which is the kind of wrong that makes a
 * translation read as machine output however good the vocabulary is.
 */
const FORMS = { one: "{n} message", other: "{n} messages" };
afterEach(() => setCatalog("en", { strings: {}, plurals: {} }));

describe("Russian plurals", () => {
  it("picks one, few and many by the language's own rule", () => {
    setCatalog("ru", ru);
    expect(plural(1, FORMS)).toBe("1 письмо");     // one
    expect(plural(2, FORMS)).toBe("2 письма");     // few
    expect(plural(3, FORMS)).toBe("3 письма");
    expect(plural(5, FORMS)).toBe("5 писем");      // many
    expect(plural(11, FORMS)).toBe("11 писем");    // 11-14 are many, not few
    expect(plural(21, FORMS)).toBe("21 письмо");   // 21 is one again
    expect(plural(22, FORMS)).toBe("22 письма");
    expect(plural(25, FORMS)).toBe("25 писем");
    expect(plural(0, FORMS)).toBe("0 писем");
  });

  it("carries every form for each counted string it ships", () => {
    // A catalogue missing `few` silently falls back to `other`, which is
    // grammatical often enough to go unnoticed and wrong the rest of the time.
    for (const [key, forms] of Object.entries(ru.plurals)) {
      for (const cat of ["one", "few", "many", "other"] as const) {
        expect(forms[cat], `${key} is missing "${cat}"`).toBeTruthy();
      }
    }
  });
});
