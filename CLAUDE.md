# Notes for Claude

Things that are true of this repository and cost somebody a round trip to
find out. Not a style guide — `CONTRIBUTING.md` is that.

## Translations

Nine languages ship alongside English: German, Spanish, French, Dutch,
Portuguese (Brazil), Russian, Ukrainian, Simplified Chinese and Japanese, in
`web/src/locales/`. A missing key renders its English source rather than
failing, so an untranslated string is invisible until somebody reading that
language finds it.

**Any change that adds or alters a user-visible string adds work in all nine
catalogues.** Say so explicitly when reporting the change — how many keys, and
the fallback count before and after — and say so just as explicitly when a
change adds none, so it is never left to be inferred.

### The catalogue key for a plural is the `other` form

`plural()` looks the entry up by `forms.other`, so a call site written as

```ts
plural(n, { one: "Deleted {n} contact", other: "Deleted {n} contacts" })
```

is keyed on **`"Deleted {n} contacts"`**. Keying the catalogue on the `one`
form type-checks, builds, passes every test, and silently falls back to English
in all nine languages. Nothing errors. The only signal is the fallback count
going up, so read it:

```sh
npm run i18n:check                    # literals wrapped, and catalogue health
node scripts/i18n-catalog-check.mjs   # per-language: translated / used / falling back
```

Compare the "falling back to English" number against `main` before and after.
It should not rise. Do not read the percentage instead — adding keys moves the
denominator, so it can hold steady while new strings go untranslated.

Plural forms are per language, from `Intl.PluralRules`: `one`/`other` for most,
`one`/`few`/`many`/`other` for Russian and Ukrainian, `other` alone for Japanese
and Chinese. Supplying a form a language does not draw is inventing a
distinction, not being thorough.

## Verifying UI work

Store tests do not exercise the component. At least one bug in this repo's
history — a shift-click range measured inside a `setState` updater, which React
runs after the anchor ref has already moved — passed every store assertion and
failed the moment the built app was driven. If a change is visible on screen,
run it: `npm run dev:mock` (mock Stalwart, credentials printed on start), then
drive the real thing. Add a component test for what you find; there are
examples in `web/src/views/*/__tests__/`.
