#!/usr/bin/env node
/*
 * Wrap the strings a codemod can safely wrap, and report the ones it cannot.
 *
 * Roughly 1,000 strings is too many to hand-edit without introducing typos
 * into the copy itself, and a parser does not get bored. But it must not be
 * trusted with everything: text that is split around an interpolation arrives
 * as separate fragments, and wrapping each fragment on its own produces
 * "Move " and " messages", which no translator can do anything with. Those are
 * left alone and listed, because they need a sentence built by hand.
 *
 *   node scripts/i18n-extract.mjs <file...>   rewrite in place
 *   node scripts/i18n-extract.mjs --dry <file...>
 */
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";

const ATTRS = new Set(["title", "aria-label", "placeholder", "alt", "label", "hint", "confirmLabel", "description"]);
const NOT_PROSE = /^[\s·—–\-:;,.()[\]{}/|+×✓~<>#*@0-9]*$/u;
/*
 * Elements whose text is not prose however much it looks like it. `label:name`
 * inside <code> is a search operator: translating it breaks the thing it
 * documents. The first run of this wrapped exactly that, which is why the list
 * exists.
 */
const CODE_TAGS = new Set(["code", "kbd", "pre", "samp", "var"]);
/*
 * JSX decodes HTML entities in text; a JS string literal does not. Moving
 * `Language &amp; region` into t("...") without decoding renders the entity
 * literally on screen -- which the first run of this did, and which no
 * typecheck or test noticed. It took looking at the page.
 */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", mdash: "—", ndash: "–", hellip: "…", times: "×", middot: "·" };
const decode = (s) => s.replace(/&(\w+);/g, (whole, name) => ENTITIES[name] ?? whole)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const tagOf = (node, src) => (ts.isJsxElement(node) ? node.openingElement.tagName.getText(src) : "");
const optedOut = (node, src) => {
  const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
  return Boolean(opening?.attributes.properties.some((a) =>
    ts.isJsxAttribute(a) && a.name.getText(src) === "translate" &&
    a.initializer && ts.isStringLiteral(a.initializer) && a.initializer.text === "no"));
};

const dry = process.argv.includes("--dry");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
let wrapped = 0;
const skipped = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  /*
   * `t` is a natural name for a callback parameter, and several files already
   * use it -- `(t: SieveTest) => ...`, `.map((t) => ...)`. An import called
   * `t` is shadowed inside those callbacks, silently where the local happens
   * to be callable. So the name is checked first and aliased where it is
   * taken, per file, rather than assumed to be free.
   */
  let bound = false;
  const scan = (n) => {
    if ((ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === "t") bound = true;
    ts.forEachChild(n, scan);
  };
  scan(src);
  const T = bound ? "translate" : "t";
  /** [start, end, replacement] — applied back-to-front so offsets hold. */
  const edits = [];

  const visit = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      if (CODE_TAGS.has(tagOf(node, src).toLowerCase()) || optedOut(node, src)) return;   // and not its children
      const kids = node.children;
      const meaningful = kids.filter((c) => !(ts.isJsxText(c) && !c.text.trim()));
      for (const c of kids) {
        if (!ts.isJsxText(c)) continue;
        const raw = c.text;
        const body = raw.trim();
        if (body.length < 2 || NOT_PROSE.test(body)) continue;
        /*
         * "Split around an interpolation" is the dangerous case, and it is
         * narrower than "has siblings". `<Plus /> New rule` is a phrase next
         * to an icon: wrapping it alone is correct, and refusing it left a
         * third of the remaining work to be done by hand for no reason.
         * `Your script “{name}” was written by hand` is the real thing --
         * a sibling that renders text, so the fragments are not sentences.
         */
        const textSibling = kids.some((k) => k !== c && ts.isJsxExpression(k) && k.expression && !(() => {
          let jsx = false;
          const w = (n) => { if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) { jsx = true; return; } ts.forEachChild(n, w); };
          w(k.expression);
          return jsx;
        })());
        if (textSibling) {
          const { line } = src.getLineAndCharacterOfPosition(c.getStart(src));
          skipped.push({ file, line: line + 1, why: "text split around an expression", text: body.slice(0, 52) });
          continue;
        }
        if (decode(body).includes('"')) {
          const { line } = src.getLineAndCharacterOfPosition(c.getStart(src));
          skipped.push({ file, line: line + 1, why: "contains a quote", text: body.slice(0, 52) });
          continue;
        }
        // Keep the original leading/trailing whitespace: JSX collapses it, and
        // reflowing here would change the rendered spacing.
        const lead = raw.slice(0, raw.indexOf(body[0]));
        const tail = raw.slice(raw.lastIndexOf(body[body.length - 1]) + 1);
        edits.push([c.getStart(src), c.getEnd(), `${lead}{${T}("${decode(body.replace(/\s+/g, " "))}")}${tail}`]);
        wrapped++;
      }
    }
    if (ts.isJsxAttribute(node) && ATTRS.has(node.name.getText(src))) {
      const i = node.initializer;
      const lit = i && (ts.isStringLiteral(i) ? i : ts.isJsxExpression(i) && i.expression && ts.isStringLiteral(i.expression) ? i.expression : null);
      if (lit && lit.text.trim().length > 1 && !NOT_PROSE.test(lit.text)) {
        if (decode(lit.text).includes('"')) {
          const { line } = src.getLineAndCharacterOfPosition(lit.getStart(src));
          skipped.push({ file, line: line + 1, why: "contains a quote", text: lit.text.slice(0, 52) });
        } else {
          edits.push([i.getStart(src), i.getEnd(), `{${T}("${decode(lit.text)}")}`]);
          wrapped++;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  if (!edits.length) continue;

  let out = text;
  for (const [start, end, rep] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, start) + rep + out.slice(end);
  if (!/from "@\/lib\/i18n"/.test(out)) {
    const lastImport = [...out.matchAll(/^import .*?;$/gm)].pop();
    const decl = bound ? 'import { t as translate } from "@/lib/i18n";' : 'import { t } from "@/lib/i18n";';
    if (lastImport) out = out.slice(0, lastImport.index + lastImport[0].length) + "\n" + decl + out.slice(lastImport.index + lastImport[0].length);
  }
  if (!dry) writeFileSync(file, out);
}

console.log(`${dry ? "would wrap" : "wrapped"} ${wrapped} strings across ${files.length} files`);
if (skipped.length) {
  console.log(`\n${skipped.length} left for a person:`);
  for (const s of skipped) console.log(`  ${s.file.replace("web/src/", "")}:${s.line}  (${s.why})  ${s.text}`);
}
