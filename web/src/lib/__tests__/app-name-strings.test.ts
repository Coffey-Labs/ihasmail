/*
 * An instance renamed with APP_NAME should be called by its name everywhere,
 * not only on the sign-in page and in the title bar. So no sentence shown to
 * a person may write "ihasmail" into itself: it takes the name as {app}.
 *
 * The exceptions are the places where "ihasmail" is not the app's name but a
 * literal a person could go and look at: the Files folder, the Sieve script
 * and the project's own address. Renaming those would rename real data.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Strings that name a stored thing, not the app. */
const LITERALS = [
  "Images are stored in your Files (folder “ihasmail”) and embedded when you send.",
  "“{name}” will be deactivated (not deleted) and a new “ihasmail” script will take over.",
  "Another script (“{name}”) is active. Saving rules here will activate the “ihasmail” script instead.",
  "ihasmail.org",
  "ihasmail",
];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "locales" || name === "__tests__") continue;
      sources(path, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** Every translated string in a file, however `t` was imported. */
function translatedStrings(code: string): string[] {
  return [...code.matchAll(/\b(?:t|tNode|translate)\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    JSON.parse(`"${m[1]}"`),
  );
}

describe("text that names the app", () => {
  it("takes the name as {app} instead of writing ihasmail into the sentence", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      for (const s of translatedStrings(readFileSync(file, "utf8"))) {
        if (s.includes("ihasmail") && !LITERALS.includes(s)) {
          offenders.push(`${file.slice(SRC.length)}: ${s.slice(0, 60)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps a placeholder in every translation of those strings", () => {
    const catalogs = readdirSync(join(SRC, "locales")).filter((f) => f.endsWith(".ts") && f !== "index.ts");
    const wrong: string[] = [];
    for (const name of catalogs) {
      const code = readFileSync(join(SRC, "locales", name), "utf8");
      for (const m of code.matchAll(/^\s*"((?:[^"\\]|\\.)*)": "((?:[^"\\]|\\.)*)",$/gm)) {
        const key = JSON.parse(`"${m[1]}"`);
        const value = JSON.parse(`"${m[2]}"`);
        // A key that takes the name must not hard-code it in the translation.
        if (key.includes("{app}") && value.includes("ihasmail")) wrong.push(`${name}: ${key.slice(0, 50)}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
