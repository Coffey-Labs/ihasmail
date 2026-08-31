import { createElement, Fragment, useSyncExternalStore, type ReactNode } from "react";
import { DEFAULT_UI_LANGUAGE, resolveUiLanguage } from "@/lib/languages";

/**
 * Translation, in about as little machinery as the job takes.
 *
 * The English text is the key. `t("Archive")` looks "Archive" up in whatever
 * catalogue is loaded and returns the English if it is not there, which buys
 * three things worth more than tidy symbolic keys: there is no English
 * catalogue to keep in step with the code, a missing translation degrades to
 * readable English rather than to `mail.list.archive`, and extracting a string
 * is wrapping it rather than inventing a name for it. Names are where
 * extraction stalls -- 55 components is a lot of small naming arguments.
 *
 * The cost is that changing English copy orphans its translations. That is the
 * right trade here: the copy is the product, and a stale translation should
 * fall back to the new English rather than keep showing the old sentence in
 * German.
 */

export type Vars = Record<string, string | number>;

/** One entry per plural category the language actually uses. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

export interface Catalog {
  /** English source → translation. */
  strings: Record<string, string>;
  /** English `other` form → the forms this language needs. */
  plurals: Record<string, PluralForms>;
}

const EMPTY: Catalog = { strings: {}, plurals: {} };

let current: Catalog = EMPTY;
let currentTag: string = DEFAULT_UI_LANGUAGE;
let version = 0;
const listeners = new Set<() => void>();

function publish(): void {
  version += 1;
  for (const fn of listeners) fn();
}

/**
 * Fill in `{name}` placeholders.
 *
 * Named rather than positional, because a translator reorders a sentence and
 * positional arguments do not survive that -- German puts the verb last, and
 * "{0} of {1}" becomes a different order with the same meaning.
 */
export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  );
}

/** Translate, falling back to the English that was passed in. */
export function t(source: string, vars?: Vars): string {
  return interpolate(current.strings[source] ?? source, vars);
}

/**
 * Translate where the English word is doing two jobs.
 *
 * English-as-key has one real weakness and this is it: "Archive" is the button
 * that archives a message and the folder the message lands in, and German
 * needs "Archivieren" for the first and "Archiv" for the second. One key
 * cannot hold both. "Important" is the same — a priority tag and a folder.
 *
 * So a context can be given, and the lookup becomes context + source while the
 * fallback stays the plain English. A translator sees the context and knows
 * which sense to render; a catalogue that has not got round to it still
 * renders the English word, which was right in English all along.
 *
 * The separator is a control character rather than a punctuation mark, which
 * is the gettext convention and for the same reason: no English string can
 * contain it by accident.
 */
export const CONTEXT_SEPARATOR = "\u0004";

export function tc(context: string, source: string, vars?: Vars): string {
  const keyed = current.strings[`${context}${CONTEXT_SEPARATOR}${source}`];
  return interpolate(keyed ?? current.strings[source] ?? source, vars);
}

/**
 * Translate a counted thing.
 *
 * Two forms is an English assumption and does not survive the second phase of
 * this: Russian and Ukrainian use three, and picking between them is not
 * `n === 1`. `Intl.PluralRules` knows the rule for every language the browser
 * knows, so the catalogue supplies the forms and the runtime picks.
 *
 * The English `other` form is the key, so a call site reads as the sentence it
 * produces and needs no invented name.
 */
export function plural(n: number, forms: PluralForms, vars?: Vars): string {
  const entry = current.plurals[forms.other] ?? forms;
  let category: Intl.LDMLPluralRule = "other";
  try {
    category = new Intl.PluralRules(currentTag).select(n);
  } catch {
    /* an unknown tag: "other" is the safe form and English's only plural */
  }
  return interpolate(entry[category] ?? entry.other, { n, ...vars });
}

/**
 * A translated sentence with elements inside it.
 *
 * Some sentences have a `<code>` or a `<kbd>` in the middle of them, and the
 * two obvious approaches are both wrong. Splitting the sentence into two `t()`
 * calls hands a translator "This browser cannot register apps for" and "links,
 * in particular…", which are not sentences and cannot be reordered into a
 * language that puts the verb somewhere else. Dropping the element and
 * interpolating plain text keeps the sentence whole but loses the monospace
 * that told the reader it was a literal.
 *
 * So the sentence stays whole and the elements are placeholders in it:
 *
 *   tNode("Open {scheme} links in ihasmail.", { scheme: <code>mailto:</code> })
 *
 * A translator sees one sentence with a named hole and can put the hole
 * wherever their language wants it.
 */
export function tNode(source: string, parts: Record<string, ReactNode>, vars?: Vars): ReactNode {
  const translated = interpolate(current.strings[source] ?? source, vars);
  const out: ReactNode[] = [];
  let last = 0;
  const re = /\{(\w+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(translated))) {
    if (!Object.prototype.hasOwnProperty.call(parts, m[1]!)) continue;
    if (m.index > last) out.push(translated.slice(last, m.index));
    // Keyed, because this is an array and React asks; the index is stable for
    // a given rendering of a given sentence.
    out.push(createElement(Fragment, { key: `${m[1]}-${m.index}` }, parts[m[1]!]));
    last = m.index + m[0].length;
  }
  if (last < translated.length) out.push(translated.slice(last));
  return out;
}

/** Subscribe to catalogue changes without React. Used by the tests. */
export function subscribeForTest(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The language in force, for anything that needs the tag itself. */
export function currentLanguage(): string {
  return currentTag;
}

/**
 * Put a catalogue in force.
 *
 * Exported for tests and for the loader; nothing else should call it, because
 * the tag and the catalogue have to move together or `plural` selects with one
 * language's rules against another's forms.
 */
export function setCatalog(tag: string, catalog: Catalog): void {
  /*
   * Publishing only when something actually changed is not an optimisation
   * here, it is the thing that stops an infinite loop.
   *
   * The root keys its tree on the language version, so a publish remounts
   * everything. Remounting re-runs the effect that fetches the account's
   * settings file, which calls `hydrate`, which calls `applyLang`, which lands
   * back here -- with the identical tag and the identical catalogue. Publishing
   * that non-change bumped the version again and went round for ever: the
   * message list refetched on every pass, which is what it looked like from
   * the outside.
   *
   * Reference equality is enough. `EMPTY` is a module constant and a
   * dynamically imported catalogue is cached, so the same language really does
   * hand back the same object.
   */
  if (currentTag === tag && current === catalog) return;
  currentTag = tag;
  current = catalog;
  publish();
}

/**
 * Load and apply a language.
 *
 * English is the built-in: it is the source text, so there is nothing to fetch
 * and no chance of a missing catalogue leaving the app blank. Everything else
 * is a dynamic import, so a reader who never leaves English never downloads a
 * catalogue -- which matters, because the main bundle is already large enough
 * to warn about.
 */
/**
 * The catalogue load that is in flight, so the first paint can wait for it.
 *
 * Without this, a cold load paints before the catalogue lands. Components
 * recover -- the tree is rebuilt when the catalogue arrives -- but a string
 * computed in an effect does not: a toast fired in that window is emitted in
 * English and stays English, in an interface that is otherwise German.
 * Reported as a stale-folder toast that ignored the language setting.
 */
let inFlight: Promise<void> = Promise.resolve();

/** Resolves once the chosen language is in force. English resolves at once. */
export function whenLanguageReady(): Promise<void> {
  return inFlight;
}

export async function loadLanguage(tag: string): Promise<void> {
  inFlight = loadLanguageNow(tag);
  return inFlight;
}

async function loadLanguageNow(tag: string): Promise<void> {
  const resolved = resolveUiLanguage(tag);
  if (resolved === DEFAULT_UI_LANGUAGE) {
    setCatalog(DEFAULT_UI_LANGUAGE, EMPTY);
    return;
  }
  try {
    const mod = (await import(`../locales/${resolved}.ts`)) as { catalog: Catalog };
    setCatalog(resolved, mod.catalog);
  } catch {
    // A catalogue that will not load leaves English in force rather than a
    // half-rendered page. `resolveUiLanguage` should already have prevented
    // this; it being reachable at all is why it is caught.
    setCatalog(DEFAULT_UI_LANGUAGE, EMPTY);
  }
}

/**
 * Re-render when the language changes.
 *
 * Used once, at the root, to key the tree — rather than at each of the
 * thousand call sites, which would make `t()` a hook and extraction far more
 * invasive than wrapping a string. Language changes are rare enough that
 * re-rendering everything is the cheaper design.
 */
export function useLanguageVersion(): number {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
    () => version,
  );
}
