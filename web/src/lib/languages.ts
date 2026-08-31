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
}

export const UI_LANGUAGES: readonly UiLanguage[] = [
  { tag: "en", name: "English" },
];

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
