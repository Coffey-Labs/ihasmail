#!/usr/bin/env node
/*
 * How much of the interface is extracted, and what is left.
 *
 * Extraction is ~1,000 strings across ~56 files, which is far too many to
 * carry in anyone's head or to eyeball in review. This counts what is still
 * hardcoded so the work can be done a file at a time and the remainder is
 * always a number rather than a feeling.
 *
 * It is a progress report, not a gate: run it, do a file, run it again. It
 * exits non-zero only with --check, so CI can be told to fail on regressions
 * later, once the number is low enough for that to mean something.
 */
import ts from "typescript";
import { readFileSync, globSync } from "node:fs";

/** Attributes a person reads. `className` and `key` are not among them. */
const ATTRS = new Set(["title", "aria-label", "placeholder", "alt", "label", "hint", "confirmLabel", "message", "description"]);
/* Text that is not prose: punctuation, separators, and the single glyphs used
   as dividers. Counting these as untranslated would put a floor under the
   number that no amount of work could reach. */
const NOT_PROSE = /^[\s·—–\-—:;,.()[\]{}/|+×✓~<>#*@0-9]*$/u;
/*
 * Text that is deliberately not translated is not "remaining work". Counting
 * it put a floor under the number that no amount of effort could reach -- the
 * report sat at 21 with only 6 real items left, which makes the number
 * something to argue with rather than act on. Same rule the codemod uses.
 */
const CODE_TAGS = new Set(["code", "kbd", "pre", "samp", "var"]);
const optedOut = (node, src) => {
  const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
  return Boolean(opening?.attributes.properties.some((a) =>
    ts.isJsxAttribute(a) && a.name.getText(src) === "translate" &&
    a.initializer && ts.isStringLiteral(a.initializer) && a.initializer.text === "no"));
};

const files = globSync("web/src/**/*.tsx").filter((f) => !f.includes("__tests__"));
const rows = [];
let done = 0, todo = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let left = 0;
  const wrapped = (text.match(/\bt\(\s*["'`]/g) || []).length + (text.match(/\bplural\(/g) || []).length;
  const visit = (node) => {
    if ((ts.isJsxElement(node) && CODE_TAGS.has(node.openingElement.tagName.getText(src).toLowerCase())) || optedOut(node, src)) return;
    if (ts.isJsxText(node) && node.text.trim().length > 1 && !NOT_PROSE.test(node.text.trim())) left++;
    if (ts.isJsxAttribute(node) && ATTRS.has(node.name.getText(src))) {
      const i = node.initializer;
      const lit = i && (ts.isStringLiteral(i) ? i : ts.isJsxExpression(i) && i.expression && ts.isStringLiteral(i.expression) ? i.expression : null);
      // The same prose test the text nodes get. Without it, placeholders that
      // are format examples -- "123456" for a one-time code, "+1 555 0100" for
      // a phone -- counted as untranslated work forever.
      if (lit && lit.text.trim().length > 1 && !NOT_PROSE.test(lit.text.trim())) left++;
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  done += wrapped;
  todo += left;
  if (left) rows.push([file.replace("web/src/", ""), left, wrapped]);
}

rows.sort((a, b) => b[1] - a[1]);
const pct = done + todo === 0 ? 100 : Math.round((done / (done + todo)) * 100);
console.log(`i18n extraction: ${done} wrapped, ${todo} remaining across ${rows.length} files  (${pct}%)\n`);
for (const [f, left, w] of rows.slice(0, Number(process.argv.find((a) => a.startsWith("--top="))?.slice(6) ?? 15))) {
  console.log(`  ${String(left).padStart(4)} left${w ? `, ${w} done` : "       "}  ${f}`);
}
if (rows.length > 15 && !process.argv.includes("--all")) console.log(`\n  …and ${rows.length - 15} more (--all, or --top=N)`);
if (process.argv.includes("--check") && todo > 0) process.exit(1);
