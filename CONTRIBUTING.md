# Contributing to ihasmail

Thanks for your interest in contributing to **ihasmail** — an immutable, JMAP-only webmail client for [Stalwart Mail Server](https://stalw.art/). Contributions of all kinds are welcome: bug reports, feature requests, code, documentation, and testing.

## Code of Conduct

By participating in this project, you agree to treat other contributors with respect. Be constructive, be patient with newcomers, and keep discussion focused on the project. Harassment or abusive behavior toward other contributors will not be tolerated.

## Before You Start

- ihasmail speaks **JMAP only** — it does not support IMAP/POP3/SMTP fallback paths. Keep this in mind when proposing features.
- ihasmail has **no database of its own** — all state lives in Stalwart via JMAP. Contributions should not introduce a separate persistence layer without discussion first.
- This project is licensed under **AGPL-3.0**. Any code you contribute will be distributed under this license, including for hosted/SaaS deployments.

## How to Contribute

### Reporting Bugs

Before opening a new issue, please search [existing issues](https://github.com/Coffey-Labs/ihasmail/issues) to see if it's already been reported. When filing a bug report, include:

- A clear, descriptive title
- Steps to reproduce the issue
- Expected behavior vs. actual behavior
- Your environment: browser/OS, Stalwart version, and how ihasmail is deployed (Docker, bare metal, etc.)
- Relevant logs, console errors, or screenshots
- Whether the issue is reproducible against a fresh Stalwart instance

### Suggesting Features

Open an issue describing:

- The problem you're trying to solve (not just the solution)
- How it fits with ihasmail's JMAP-only, nothing-to-persist design
- Any relevant JMAP RFC references (RFC 8620, RFC 8621) if the feature touches protocol behavior

For larger changes, please open an issue to discuss the approach **before** submitting a pull request — this saves everyone time if the direction needs adjusting.

### Submitting Pull Requests

1. **Fork** the repository and create your branch from `main`.
2. **Name your branch** descriptively, e.g. `fix/thread-view-scroll` or `feat/search-filters`.
3. **Keep PRs focused** — one logical change per PR. Large, unrelated changes bundled together are harder to review and more likely to be rejected.
4. **Write clear commit messages** describing what changed and why.
5. **Test your changes** against a real (or local) Stalwart instance where possible, since JMAP behavior can be subtle.
6. **Update documentation** if your change affects setup, configuration, or user-facing behavior.
7. **Open the pull request** against `main`, filling out the PR template with:
   - A summary of the change
   - Related issue number(s), if any
   - Screenshots/GIFs for UI changes
   - Any manual testing you performed
8. **Add translations** for any new user-visible string — see
   [Translations](#translations) below — and **drive the built app** for any
   change that is visible on screen, as described in
   [Verifying UI work](#verifying-ui-work).

`main` is protected. A change reaches it through a pull request whose **build**
check has passed — not afterwards — and the branch cannot be force-pushed or
deleted. No approving review is required, so a PR of your own is not blocked
waiting for one.

**CI on a PR from a fork waits to be approved.** Every workflow run on an
outside contributor's branch sits at *awaiting approval* until a maintainer
starts it by hand, so the **build** check will not appear the moment you open
the PR — that is the gate working, not a broken run. Pushing again will not
start it, and neither will closing and reopening.

### Code Style

- Match the existing formatting and naming conventions used elsewhere in the codebase.
- Keep functions small and single-purpose where practical.
- Prefer clarity over cleverness — this is a mail client people rely on for their inbox.
- Comment non-obvious JMAP interactions, especially around state/`changes` handling, since JMAP's delta-sync model can be easy to get subtly wrong.

### Translations

Nine languages ship alongside English: German, Spanish, French, Dutch,
Portuguese (Brazil), Russian, Ukrainian, Simplified Chinese and Japanese, in
`web/src/locales/`. A missing key renders its English source rather than
failing, so an untranslated string is invisible until somebody reading that
language finds it.

**Any change that adds or alters a user-visible string adds work in all nine
catalogs.** Say so explicitly in the PR — how many keys, and the fallback
count before and after — and say so just as explicitly when a change adds none,
so it is never left to be inferred.

#### The catalog key for a plural is the `other` form

`plural()` looks the entry up by `forms.other`, so a call site written as

```ts
plural(n, { one: "Deleted {n} contact", other: "Deleted {n} contacts" })
```

is keyed on **`"Deleted {n} contacts"`**. Keying the catalog on the `one`
form type-checks, builds, passes every test, and silently falls back to English
in all nine languages. Nothing errors. The only signal is the fallback count
going up, so read it:

```sh
npm run i18n:check                    # literals wrapped, and catalog health; exits 1 on a finding
node scripts/i18n-catalog-check.mjs   # per-language: translated / used / falling back
```

Compare the "falling back to English" number against `main` before and after.
It should not rise. Do not read the percentage instead — adding keys moves the
denominator, so it can hold steady while new strings go untranslated.

Plural forms are per language, from `Intl.PluralRules`: `one`/`other` for most,
`one`/`few`/`many`/`other` for Russian and Ukrainian, `other` alone for Japanese
and Chinese. Supplying a form a language does not draw is inventing a
distinction, not being thorough.

### Verifying UI work

Store tests do not exercise the component. At least one bug in this repo's
history — a shift-click range measured inside a `setState` updater, which React
runs after the anchor ref has already moved — passed every store assertion and
failed the moment the built app was driven. If a change is visible on screen,
run it: `npm run dev:mock` (mock Stalwart, credentials printed on start), then
drive the real thing. Add a component test for what you find; there are
examples in `web/src/views/*/__tests__/`.

### Development Setup

1. Clone your fork:
   ```bash
   git clone https://github.com/YOUR-USERNAME/ihasmail.git
   cd ihasmail
   ```
2. Point your local instance at a running Stalwart Mail Server (a test/dev instance is strongly recommended — do not develop against a production mailbox), or use the built-in mock below.
3. Install and run, as below.
4. Verify your changes don't break existing JMAP calls by exercising core flows: login, list/read mail, send, search, and folder/label operations.

Requirements: Node ≥ 20.19 (26 recommended), npm ≥ 10.

```bash
npm install

npm run dev            # real Stalwart (STALWART_URL in .env) — server :8080, Vite :5173
npm run dev:mock       # built-in mock Stalwart (demo@example.com / demo), mock on :8788
npm run dev:mock:no-future-release   # mock that advertises FUTURERELEASE and drops every hold

npm run typecheck      # tsc for both packages
npm test               # vitest (web) + node:test (server)
npm run build          # web/dist + server/dist
npm start              # serve the production build
```

Open http://localhost:5173 in dev, or http://localhost:8080 for the production
build.

#### Architecture

```
browser  ──(same-origin /api/*)──►  ihasmail server (Node + Hono)  ──(JMAP over HTTPS)──►  Stalwart
  React SPA                           • session cookie ⇄ Basic auth
  JMAP client + stores                • /api/jmap, /api/blob, /api/upload, /api/events (SSE), /api/image
```

- `web/` — Vite + React 19 + TypeScript SPA. `src/jmap` (client, push, types), `src/store` (zustand: session, mail, compose, contacts, calendar, files, sieve, settings), `src/views`, `src/lib` (sanitizer, search parser, Sieve codec, locale-aware dates, vCard, …).
- `server/` — Node/Hono backend: authenticates against Stalwart's JMAP session endpoint, seals the credentials with a key derived from the cookie secret, proxies JMAP/blob/SSE, serves the SPA under a strict CSP. `src/mock/` is an in-memory fake Stalwart for development and demos.

Capabilities used: `core`, `mail`, `submission`, `vacationresponse`, `sieve`,
`contacts`(+`parse`), `calendars`(+`parse`), `principals`(+`availability`),
`quota`, `blob`, `filenode`, EventSource push, plus Stalwart's own
`urn:stalwart:jmap`. Features degrade gracefully when one is missing.

#### The mock

An in-memory fake Stalwart 0.16 — enough JMAP to develop and demo against
without a real mailbox. It reproduces the things a naive fake would get wrong,
because each cost a live debugging session: `urn:stalwart:jmap` advertised
**per-account** rather than session-level, identity signatures capped at 2047
**bytes**, and `CalendarEvent/set` speaking Stalwart's vocabulary rather than
RFC 8984's.

| Switch | What it does |
| --- | --- |
| `MOCK_NO_FUTURE_RELEASE=1` | Advertises FUTURERELEASE, then drops every hold |
| `MOCK_NO_REGISTRY=1` | Omits the Stalwart capability, so the sign-in refusal can be tested |
| `MOCK_NO_SCHEDULING_SEND=1` | Refuses a calendar write that asks for scheduling messages, as for an account without that permission |
| `MOCK_ROLE` | Who the demo user is for Administration: `admin` (the default), `tenant-admin`, `helpdesk` or `user` |
| `MOCK_METRICS=off` | Refuses the dashboard's metric history, as Community does |
| `MOCK_EDITION=enterprise` | Reports Enterprise, which Tenants needs |

It tracks the current Stalwart release rather than 0.16 in general, and each
behavior is confirmed against a real server before it is copied here — the
comments say which version and on what date. Where a release changes something
a client can see, the mock changes with it, and the test that pinned the old
behavior is rewritten rather than deleted, so the reversal stays on the record.

#### Version numbers

`2026.8.30+pr129` is the date of the commit a build came from and the pull
request that commit arrived through; a commit that did not come through one
carries its short SHA instead (`2026.8.30+g1fa6578`). It is worked out from git
at build time — nothing writes a version into the tree, and `package.json` stays
at `0.0.0`. `node scripts/version.mjs` prints it for the current checkout.

The PR number sits after the `+` as build metadata because it records where a
build came from, not how new it is. The version says nothing about Stalwart on
purpose: what a build needs from the server is stated in the README badge and
in [KNOWN-ISSUES.md](KNOWN-ISSUES.md). Building an image with the version on it,
and the single-host `deploy.example.sh`, are covered in
[Installing](https://docs.ihasmail.org/install/).

## Review Process

- A maintainer will review your PR and may request changes.
- Please respond to review feedback in a timely manner; PRs with no activity for an extended period may be closed and can be reopened once updated.
- Once approved, a maintainer will merge the PR.

## Reporting Security Issues

Please **do not** open a public issue for security vulnerabilities. Instead, report them privately by emailing **johnellisATlinuxDOTcom** with details of the issue. See `SECURITY.md` if one is present in the repo for further instructions.

## Questions?

If you're unsure whether something is a good fit, open an issue and ask — discussion is welcome before you invest time in a PR.

Thanks again for helping improve ihasmail!
