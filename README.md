<p align="center">
  <img src="web/public/img/logo.png" alt="ihasmail" width="150">
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence: AGPL-3.0-or-later" src="https://img.shields.io/badge/licence-AGPL--3.0--or--later-2dd4bf?style=flat-square"></a>
  <a href="https://stalw.art" target="_blank" rel="noreferrer"><img alt="Requires Stalwart 0.16 or newer; tested against 0.16.20" src="https://img.shields.io/badge/Stalwart-0.16.20-6366f1?style=flat-square"></a>
  <a href="https://docs.ihasmail.org" target="_blank" rel="noreferrer"><img alt="Documentation: docs.ihasmail.org" src="https://img.shields.io/badge/docs-docs.ihasmail.org-0ea5e9?style=flat-square"></a>
  <a href="https://coffeylabs.org" target="_blank" rel="noreferrer"><img alt="by Coffey Labs" src="https://img.shields.io/badge/by-Coffey%20Labs-0f766e?style=flat-square"></a>
</p>

# ihasmail

**Immutable webmail for [Stalwart Mail Server](https://stalw.art) — a container
with nothing to persist, and a Gmail-class client on top of it.**

Mail, calendars, contacts, files and filters in a responsive single-page app
that works equally well on a desktop monitor and a phone. It talks only JMAP
(plus Stalwart's blob/upload/EventSource endpoints) — no IMAP, no SMTP, no
database, and with `IMMUTABLE=1` no writable filesystem either. Everything
durable belongs to Stalwart; the container is disposable.

| | |
| --- | --- |
| 🌐 **[ihasmail.org](https://ihasmail.org)** | What it is, what it looks like, the full feature list |
| 📘 **[docs.ihasmail.org](https://docs.ihasmail.org)** | [Installing](https://docs.ihasmail.org/install/) · [Configuring](https://docs.ihasmail.org/configure/) · [Using it](https://docs.ihasmail.org/using/) · [Shortcuts](https://docs.ihasmail.org/shortcuts/) · [Rebranding](https://docs.ihasmail.org/rebranding/) · [Troubleshooting](https://docs.ihasmail.org/troubleshooting/) |
| 🧪 **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)** | What was verified live, and where Stalwart departs from a spec |
| 🛣 **[ROADMAP.md](ROADMAP.md)** | What ihasmail does not do, and why |

This file is for people working *on* ihasmail. Everything about running it
lives in the docs.

## Screenshots

*Taken against the built-in mock server (`npm run dev:mock`) with sample data — no real mailbox involved.*

| | |
| --- | --- |
| **Inbox & conversation (dark)** ![Inbox, dark theme](docs/screenshots/inbox-dark.jpg) | **Inbox & conversation (light)** ![Inbox, light theme](docs/screenshots/inbox-light.jpg) |
| **Composer** ![Composer](docs/screenshots/compose.jpg) | **Calendar** ![Calendar](docs/screenshots/calendar.jpg) |
| **Contacts** ![Contacts](docs/screenshots/contacts.jpg) | **Sieve filter builder** ![Filters](docs/screenshots/filters.jpg) |

More, including the mobile layout, on [ihasmail.org](https://ihasmail.org/#screenshots).

## What's in it

- **Mail** — three-pane Gmail-style layout, conversation view, virtualised list, labels, undo, Gmail search operators and keyboard shortcuts, Sieve rules from a message's context menu, sanitised HTML with remote images blocked, read receipts, invitations and RSVP, multi-composer rich-text editing with signatures, scheduled send and undo send
- **Calendar** — JMAP Calendars / JSCalendar: month/week/day/agenda, recurrence, attendees and free-busy, colour categories
- **Contacts** — JMAP Contacts / JSContact: address books, groups, full editor, vCard import/export
- **Files** — JMAP FileNode: browse, upload, download, rename, move, delete
- **Settings that follow the account**, not the browser — kept in a `settings.json` in the account's own JMAP Files, so ihasmail itself stays stateless
- **Runs read-only** — one optional write path, and with it switched off the container needs no volume and no writable root. `IMMUTABLE=1` is checked at startup rather than trusted, so a half-applied switch refuses to boot instead of failing quietly. See [Running immutably](#running-immutably)
- **Platform** — installable PWA, Web Push with ihasmail closed, `mailto:` handler, no credentials in the browser, strict CSP, SSRF-safe image proxy

The long version is on [ihasmail.org](https://ihasmail.org/#features); how to
drive each one is in [Using ihasmail](https://docs.ihasmail.org/using/).

## Requires Stalwart 0.16 or newer

Sign-in refuses anything older, by name. 0.16 replaced the REST management API
with JMAP registry objects, changed the shape of `FileNode`, split its rights up
and moved configuration into the store; supporting both generations meant a
wrong guess had somewhere to fall back to, so it failed *quietly* — and that
reached production. With one supported generation a wrong guess is a loud error
on the first call.

- Still on 0.15? The last release that runs on it is tagged [`stalwart-0.15-support`](https://github.com/Coffey-Labs/ihasmail/releases/tag/stalwart-0.15-support).
- Upgrading? [stalwart-migrator](https://github.com/Coffey-Labs/stalwart-migrator) does it in place, checkpointing every phase and validating afterwards. The live instance moved 0.15.5 → 0.16.19 with eight seconds of downtime and nothing lost.

## Quick start (Docker)

```bash
cp .env.example .env
# edit: STALWART_URL=https://mail.example.com  and  APP_SECRET=$(openssl rand -base64 48)
docker compose up --build -d
# → http://localhost:8080  (put Caddy/nginx in front for TLS; see Caddyfile.example / nginx.example.conf)
```

Users sign in with their Stalwart mailbox credentials. **An account with
two-factor authentication needs an app password**, created in Stalwart's own
settings — Stalwart accepts a TOTP code only through an OAuth flow and offers no
password grant, so no client holding a username and password can exchange them
plus a code for a token.

Full instructions, TLS, and every environment variable:
[Installing](https://docs.ihasmail.org/install/) ·
[Configuring](https://docs.ihasmail.org/configure/).

### Running immutably

The server writes to exactly one path, the optional `SESSION_FILE`. Clear it
and there is nothing left to write, so the container can run with no writable
filesystem at all:

```bash
docker run --read-only --tmpfs /tmp -e IMMUTABLE=1 -e SESSION_FILE= ...
```

`IMMUTABLE=1` is an assertion the server checks at startup rather than a switch
that changes what it does: it refuses to start if `SESSION_FILE` is still set,
or if the filesystem it is installed on turns out to be writable after all.
Without it the same misconfiguration is silent — sessions are held in memory
and persisting them is best-effort, so a read-only `/data` costs one warning at
the first sign-in and nothing else until the instance is replaced and everyone
is signed out.

That sign-out is the standing cost of this mode today, since sessions have
nowhere to live across a restart. Removing it means moving the session upstream
into a token Stalwart itself issues and can revoke, which is what the OAuth work
in [ROADMAP.md](ROADMAP.md) is for.

## Architecture

```
browser  ──(same-origin /api/*)──►  ihasmail server (Node + Hono)  ──(JMAP over HTTPS)──►  Stalwart
  React SPA                           • session cookie ⇄ Basic auth
  JMAP client + stores                • /api/jmap, /api/blob, /api/upload, /api/events (SSE), /api/image
```

- `web/` — Vite + React 19 + TypeScript SPA. `src/jmap` (client, push, types), `src/store` (zustand: session, mail, compose, contacts, calendar, files, sieve, settings), `src/views`, `src/lib` (sanitiser, search parser, Sieve codec, locale-aware dates, vCard, …).
- `server/` — Node/Hono backend: authenticates against Stalwart's JMAP session endpoint, seals the credentials with a key derived from the cookie secret, proxies JMAP/blob/SSE, serves the SPA under a strict CSP. `src/mock/` is an in-memory fake Stalwart for development and demos.

Capabilities used: `core`, `mail`, `submission`, `vacationresponse`, `sieve`,
`contacts`(+`parse`), `calendars`(+`parse`), `principals`(+`availability`),
`quota`, `blob`, `filenode`, EventSource push, plus Stalwart's own
`urn:stalwart:jmap` (read-only). Features degrade gracefully when one is
missing.

## Development

Requirements: Node ≥ 20.10 (22 recommended), npm ≥ 10.

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
build. Running it for real is covered in
[Installing](https://docs.ihasmail.org/install/) and
[Configuring](https://docs.ihasmail.org/configure/).

### The mock

An in-memory fake Stalwart 0.16 — enough JMAP to develop and demo against
without a real mailbox. It reproduces the things a naive fake would get wrong,
because each cost a live debugging session: `urn:stalwart:jmap` advertised
**per-account** rather than session-level, identity signatures capped at 2047
**bytes**, and `CalendarEvent/set` speaking Stalwart's vocabulary rather than
RFC 8984's. Two switches: `MOCK_NO_FUTURE_RELEASE=1` advertises FUTURERELEASE
and then drops every hold; `MOCK_NO_REGISTRY=1` omits the Stalwart capability so
the sign-in refusal can be tested.

### Version numbers

`ihasmail v2026.8.30+pr129` — the date of the commit this was built from, and
the pull request that commit arrived through. A commit that did not arrive
through one carries its short SHA instead: `2026.8.30+g1fa6578`. It all comes
from git at build time; nothing writes a version into the tree, and
`package.json` sits at `0.0.0` because it is no longer the source of anything.

The date is the commit's own rather than today's, so rebuilding an old commit
gives the version it had the first time.

```bash
node scripts/version.mjs        # the version for the current checkout
docker build --build-arg IHASMAIL_VERSION="$(node scripts/version.mjs)" -t ihasmail:2026.8.30 .
```

`.dockerignore` excludes `.git` deliberately, so an image build cannot work this
out for itself — pass it in. Left out, the build reports `0.0.0`, which is meant
to look wrong: a version with no `+pr` or `+g` means whoever built the image did
not pass one.

The version says nothing about Stalwart, deliberately. It used to: `2.16.x` had
`16` for the 0.16 generation it targeted, which leaves nowhere to go once
Stalwart reaches 1.0 — `2.1` sorts *below* the `2.16` already deployed, so every
image and About screen would read as a downgrade. Which Stalwart a build needs is
stated where it can be precise, in the badge at the top of this file and in
[KNOWN-ISSUES.md](KNOWN-ISSUES.md), rather than compressed into one digit.

The pull request lives after the `+`, as build metadata, because it is
provenance rather than a rank: at the rate they merge here it climbs without
bound and says nothing about how new a build is. Everything after the `+` is
ignored when versions are compared, which is the right reading — two builds from
the same day differ in where they came from, not in age. Nothing here depends on
that comparison: images are pruned oldest-first by creation time, and a rollback
names a git ref.

### Deploying

[`deploy.example.sh`](deploy.example.sh) is a single-host Docker deploy: it
fetches, refuses anything held back by `.deploy-hold`, shows what is about to be
introduced and asks, rebuilds with the right version baked in, replaces the
container, waits for healthy, then prunes all but the newest
`IHASMAIL_KEEP_VERSIONS` images — never the one actually running.

```bash
./deploy.sh                 # origin/main, asks before shipping new commits
./deploy.sh --dry-run       # run the guards and stop
./deploy.sh v2026.8.30 --yes  # a named ref, no prompt (there is no tty over ssh)
```

`--yes` does not override a hold; clearing one means deleting its line.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) ·
[SECURITY.md](SECURITY.md) — please report vulnerabilities privately.

## License

Copyright (C) 2026 Coffey Labs — AGPL-3.0-or-later. See
[LICENSE](LICENSE).

ihasmail was relicensed from GPL-3.0 to AGPL-3.0 on 2026-08-25: webmail is
nearly always run as a network service rather than handed to anyone as a binary,
and the AGPL's section 13 closes that gap.

That offer has to point at *your* source, not this one. If you run a modified
ihasmail, set `SOURCE_URL` to your own repository — the sign-in page and
Settings › About both show it. See
[Rebranding](https://docs.ihasmail.org/rebranding/).
