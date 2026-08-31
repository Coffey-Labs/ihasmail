#!/usr/bin/env node
/*
 * Every source string a catalogue needs, straight out of the calls.
 *
 * The English text is the key, so the catalogue's keys are not a list somebody
 * maintains -- they are whatever t(), tNode() and plural() are actually asked
 * for. Reading them from the code means a catalogue can never drift out of
 * step with the app in the one direction that matters: a key that no longer
 * exists is dead weight, but a call with no key is an untranslated string
 * nobody noticed.
 */
import ts from "typescript";
import { readFileSync, globSync } from "node:fs";

const strings = new Set();
const plurals = new Set();

for (const file of globSync("web/src/**/*.{ts,tsx}").filter((f) => !f.includes("__tests__"))) {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fn = node.expression.text;
      const a0 = node.arguments[0];
      if ((fn === "t" || fn === "translate" || fn === "tNode") && a0 && ts.isStringLiteral(a0)) strings.add(a0.text);
      if (fn === "plural" && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) {
        const other = node.arguments[1].properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(src) === "other");
        const forms = {};
        for (const p of node.arguments[1].properties) {
          if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer)) forms[p.name.getText(src)] = p.initializer.text;
        }
        if (other) plurals.add(JSON.stringify(forms));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
}

const out = { strings: [...strings].sort(), plurals: [...plurals].map((p) => JSON.parse(p)) };
if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`${out.strings.length} strings, ${out.plurals.length} plural sets`);
  const short = out.strings.filter((s) => s.length <= 30).length;
  console.log(`  ${short} short (<=30 chars), ${out.strings.length - short} longer`);
}
