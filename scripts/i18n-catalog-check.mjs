#!/usr/bin/env node
/*
 * Check a catalogue against the strings the code actually asks for.
 *
 * Two failures, and only one of them is visible without this.
 *
 * A *missing* key renders English. That is the designed fallback and shows up
 * as an untranslated word on screen, which somebody will eventually notice.
 *
 * A *stale* key -- one whose English no longer exists, usually because it was
 * mistyped when the catalogue was written -- is silent. The translation sits
 * in the file looking correct, is never looked up, and the app renders English
 * for ever. Nothing warns, because a catalogue is only ever read by key.
 */
import ts from "typescript";
import { readFileSync, globSync } from "node:fs";

const wanted = new Set();
for (const file of globSync("web/src/**/*.{ts,tsx}").filter((f) => !f.includes("__tests__") && !f.includes("/locales/"))) {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (n) => {
    /*
     * Labels held in a constant and translated where they render -- t(s.label)
     * -- reach t() as a variable, so there is no literal for this to find and
     * every one of them looked "stale". They are collected from the constants
     * instead: a `label:` property, or a value in an object of them. Without
     * this the stale check cried wolf 33 times and would have been switched
     * off, which is the only outcome worse than not having it.
     */
    if (ts.isPropertyAssignment(n) && n.name.getText(src) === "label" && ts.isStringLiteral(n.initializer)) wanted.add(n.initializer.text);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /_LABELS?$/.test(n.name.text)) {
      const walk = (x) => { if (ts.isStringLiteral(x)) wanted.add(x.text); ts.forEachChild(x, walk); };
      if (n.initializer) walk(n.initializer);
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const fn = n.expression.text, a0 = n.arguments[0];
      if ((fn === "t" || fn === "translate" || fn === "tNode") && a0 && ts.isStringLiteral(a0)) wanted.add(a0.text);
      // tc(context, source) keys the catalogue on both, joined by the same
      // control character tc() uses. Without this the contextual entries all
      // looked stale, which is the checker's own false alarm rather than a
      // catalogue problem.
      if (fn === "tc" && a0 && ts.isStringLiteral(a0) && n.arguments[1] && ts.isStringLiteral(n.arguments[1])) {
        // Only the contextual key is required. The plain one is tc()'s
        // fallback, not a second obligation -- asking for both would report
        // work that does not exist.
        wanted.add(`${a0.text}\u0004${n.arguments[1].text}`);
      }
      if (fn === "plural" && n.arguments[1] && ts.isObjectLiteralExpression(n.arguments[1])) {
        for (const p of n.arguments[1].properties) {
          if (ts.isPropertyAssignment(p) && p.name.getText(src) === "other" && ts.isStringLiteral(p.initializer)) wanted.add(p.initializer.text);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}

/*
 * A catalogue and a picker entry are two halves of one thing, and either half
 * alone is dead weight. A catalogue with no entry in UI_LANGUAGES never
 * reaches a reader -- it builds, it passes every test, and the language simply
 * is not offered. That happened to Dutch: the entry was added by a text
 * replacement anchored on a line that did not exist on that branch, so it was
 * a silent no-op and nothing anywhere complained.
 */
const languagesSrc = readFileSync("web/src/lib/languages.ts", "utf8");
const registered = new Set([...languagesSrc.matchAll(/tag:\s*"([\w-]+)"/g)].map((m) => m[1]));
const catalogues = new Set(globSync("web/src/locales/*.ts").map((f) => f.split("/").pop().replace(".ts", "")));

let failed = false;
for (const tag of catalogues) {
  if (!registered.has(tag)) {
    failed = true;
    console.log(`!! ${tag}.ts exists but is not in UI_LANGUAGES — the language is never offered\n`);
  }
}
for (const tag of registered) {
  if (tag !== "en" && !catalogues.has(tag)) {
    failed = true;
    console.log(`!! UI_LANGUAGES offers ${tag} but there is no ${tag}.ts — it would fall back to English\n`);
  }
}

for (const file of globSync("web/src/locales/*.ts")) {
  const tag = file.split("/").pop().replace(".ts", "");
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const have = new Set();
  const visit = (n) => {
    if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.name)) have.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(src);
  const stale = [...have].filter((k) => !wanted.has(k) && !["one", "other", "few", "many", "zero", "two"].includes(k));
  const missing = [...wanted].filter((k) => !have.has(k));
  const pct = Math.round(((wanted.size - missing.length) / wanted.size) * 100);
  console.log(`${tag}: ${wanted.size - missing.length}/${wanted.size} translated (${pct}%), ${missing.length} falling back to English`);
  if (stale.length) {
    failed = true;
    console.log(`\n  ${stale.length} STALE key(s) — translated but never looked up, so they do nothing:`);
    for (const k of stale.slice(0, 25)) console.log(`    ${JSON.stringify(k)}`);
    if (stale.length > 25) console.log(`    …and ${stale.length - 25} more`);
  }
  if (process.argv.includes("--missing")) {
    console.log(`\n  missing:`);
    for (const k of missing) console.log(`    ${JSON.stringify(k)}`);
  }
}
if (failed && process.argv.includes("--check")) process.exit(1);
