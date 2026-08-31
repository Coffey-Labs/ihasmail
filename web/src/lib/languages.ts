/**
 * The interface languages that actually have strings shipped.
 *
 * Deliberately not `lib/locales.ts`. That list is every tag CLDR can format a
 * date in — about 620 of them — and it answers a different question: what
 * calendar, clock and numerals to use. This one answers "what language is the
 * app written in", and the only honest entries are the ones somebody has
 * translated. Offering a language with no strings behind it would set
 * `<html lang>` to a language the page is not in, which is worse than not
 * offering it: it stops Chrome offering to translate a page the reader cannot
 * read.
 *
 * Wanting German dates with an English interface is a real preference, and so
 * is the reverse, which is why `uiLanguage` and `locale` are separate settings
 * rather than one.
 *
 * Adding a language means adding its catalogue and then adding it here, in
 * that order. RTL languages — Arabic, Hebrew, Persian — need bidi and layout
 * work well beyond strings, so they are not simply a matter of another entry.
 */
export interface UiLanguage {
  /** BCP 47, and what `<html lang>` is set to. */
  tag: string;
  /** The language's name in that language, which is how a picker should read. */
  name: string;
  /**
   * Machine-translated and not yet checked by somebody who speaks it.
   *
   * Stays true until a native speaker has actually read the catalogue and said
   * so. It is not a measure of how complete the file is -- a catalogue can be
   * word-for-word finished and still read like a machine wrote it, which is
   * the thing this flag is about. Removing it is a deliberate act by a person,
   * not something a coverage number earns.
   */
  beta?: boolean;
}

export const UI_LANGUAGES: readonly UiLanguage[] = [
  { tag: "en", name: "English" },
  { tag: "de", name: "Deutsch", beta: true },
  { tag: "es", name: "Español", beta: true },
  { tag: "fr", name: "Français", beta: true },
  { tag: "nl", name: "Nederlands", beta: true },
  { tag: "pt-BR", name: "Português (Brasil)", beta: true },
  { tag: "ja", name: "日本語", beta: true },
  { tag: "ru", name: "Русский", beta: true },
  { tag: "uk", name: "Українська", beta: true },
  { tag: "zh-Hans", name: "简体中文", beta: true },
];

/** Where to report a bad translation. Beta languages depend on it. */
export const TRANSLATION_ISSUE_URL = "https://github.com/Coffey-Labs/ihasmail/issues/new?title=Translation%3A%20";

export const DEFAULT_UI_LANGUAGE = "en";

/**
 * The language to actually render in.
 *
 * A stored preference is only honoured if its strings are still shipped: a
 * catalogue can be withdrawn, and an account carrying `de` from another
 * machine must not leave this one claiming to be German while showing English.
 */
export function resolveUiLanguage(stored: string | undefined | null): string {
  if (!stored) return DEFAULT_UI_LANGUAGE;
  return UI_LANGUAGES.some((l) => l.tag === stored) ? stored : DEFAULT_UI_LANGUAGE;
}
