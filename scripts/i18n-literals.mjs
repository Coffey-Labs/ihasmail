#!/usr/bin/env node
/*
 * User-visible English the extraction pass cannot see.
 *
 * `i18n:coverage` reads JSX text, and reported 100% while the calendar's
 * Day/Week/Month/Agenda buttons rendered English in all nine languages. It was
 * not wrong about what it measured -- those labels were never JSX text. They
 * were built from an expression, and so was every toast argument, every
 * `confirmDialog({ title })`, and every `Could not save: ${err}`.
 *
 * A string reaches a reader translated if either is true:
 *
 *   1. it is wrapped where it is written -- t(), tc(), tNode(), plural()
 *   2. it is a catalogue key, translated somewhere else
 *
 * The second case is a real convention here, not a loophole: constant tables
 * hold English and the render site calls `t(s.label)`. What this refuses is a
 * string that is neither -- one no catalogue has a key for, which therefore
 * cannot be translated at all, however many languages ship.
 */
import ts from "typescript";
import { readFileSync, globSync } from "node:fs";

/* Where a string literal in this position is shown to somebody. */
const UI_PROPS = new Set([
  "title", "message", "label", "confirmLabel", "cancelLabel", "ariaLabel",
  "placeholder", "hint", "occurrenceLabel", "occurrenceHint", "seriesLabel", "seriesHint",
]);
const UI_ATTRS = new Set(["title", "aria-label", "placeholder", "alt"]);
const TOASTS = new Set(["error", "success", "info", "show"]);
const WRAPPERS = ["t", "tc", "tNode", "translate", "plural"];
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
]);

/*
 * Product names, example addresses and URL scaffolding. These reach t() and
 * are deliberately absent from every catalogue -- translating "ihasmail" or
 * "name@example.com" would be a bug, not a feature -- so they would otherwise
 * be reported for ever.
 */
const NEVER_TRANSLATED = new Set([
  "ihasmail", "ihasmail.org", "ihasmail test", "Stalwart", "Stalwart Mail Server",
  "AGPL-3.0-or-later · {source}", "•••", "https://", "https://…",
  "https://meet.example.com/…", "name@example.com", "someone@example.com",
  "replies@example.com", "List-Id", "X-Spam-Status",
]);

/* Prose, not an identifier: opens like a sentence, and has lower-case letters. */
const looksLikeUi = (s) =>
  /[a-z]/.test(s) && /^[A-Z(“]/.test(s) && (/\s/.test(s) || /[.?!…]$/.test(s));

const keys = new Set();
{
  const src = readFileSync("web/src/locales/de.ts", "utf8");
  for (const m of src.matchAll(/^\s{4}"((?:[^"\\]|\\.)*)":/gm)) keys.add(m[1].replace("\\u0004", ""));
}

const found = [];
for (const file of globSync("web/src/**/*.{ts,tsx}").filter((f) => !f.includes("__tests__") && !f.includes("/locales/"))) {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const report = (node, text) => {
    if (!looksLikeUi(text) || keys.has(text) || NEVER_TRANSLATED.has(text)) return;
    const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
    found.push({ file, line: line + 1, text });
  };

  /*
   * Literals that are not text on their way to a reader.
   *
   * Two kinds. One is already inside t("...") -- walking into the call would
   * report the very string that proves it is handled. The other is an operand
   * of an equality test: `rule.name === "New filter"` compares against a
   * sentinel stored in the Sieve script, and translating it would not change
   * what a reader sees, it would break the comparison.
   */
  const exempt = new Set();
  const mark = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && WRAPPERS.includes(n.expression.text)) {
      const walk = (x) => { if (ts.isStringLiteral(x)) exempt.add(x); ts.forEachChild(x, walk); };
      for (const a of n.arguments) walk(a);
    }
    if (ts.isBinaryExpression(n) && EQUALITY.has(n.operatorToken.kind)) {
      for (const side of [n.left, n.right]) if (ts.isStringLiteral(side)) exempt.add(side);
    }
    ts.forEachChild(n, mark);
  };
  mark(src);
  const wrapped = exempt;

  const visit = (n) => {
    if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.initializer) && !wrapped.has(n.initializer)
        && UI_PROPS.has(n.name.getText(src).replace(/['"]/g, ""))) {
      report(n.initializer, n.initializer.text);
    }
    if (ts.isJsxAttribute(n) && n.initializer && UI_ATTRS.has(n.name.getText(src))) {
      const walk = (x) => {
        if (ts.isStringLiteral(x) && !wrapped.has(x)) report(x, x.text);
        if (!ts.isCallExpression(x)) ts.forEachChild(x, walk);
      };
      walk(n.initializer);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.expression.getText(src) === "toast" && TOASTS.has(n.expression.name.text)) {
      const a0 = n.arguments[0];
      if (a0 && ts.isStringLiteral(a0) && !wrapped.has(a0)) report(a0, a0.text);
      /* A template literal cannot be a catalogue key at all, so it is always a find. */
      if (a0 && ts.isTemplateExpression(a0)) report(a0, a0.head.text + "{}");
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}

if (!found.length) {
  console.log("i18n literals: none -- every user-visible string is wrapped or has a catalogue key");
  process.exit(0);
}
console.log(`${found.length} user-visible string(s) the extractor cannot see and no catalogue can translate:\n`);
for (const f of found) console.log(`  ${f.file}:${f.line}\n    ${JSON.stringify(f.text)}`);
console.log("\nWrap them in t() / plural(), or -- for a label held in a constant and");
console.log("translated where it renders -- make sure the English is a catalogue key.");
process.exit(process.argv.includes("--check") ? 1 : 0);
