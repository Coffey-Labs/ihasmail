<p align="center">
  <img src="web/public/img/logo.png" alt="ihasmail" width="180">
</p>

# ihasmail

**A fast, friendly, Gmail-class webmail for [Stalwart Mail Server](https://stalw.art) — built on JMAP, from the ground up.**

ihasmail is a JMAP-first web client: mail, calendars, contacts, files, filters and every other modern feature Stalwart exposes, in a responsive single-page app that works equally well on a desktop monitor and a phone. It talks only JMAP (plus Stalwart's blob/upload/EventSource endpoints) — no IMAP, no SMTP, no database.

> Status: 2.0 rewrite, in QA against a live Stalwart 0.15.5 server. The previous FastAPI/HTMX prototype has been removed entirely (only the logo survived).

## Screenshots

*All screenshots are taken against the built-in mock server (`npm run dev:mock`) with sample data — no real mailbox involved.*

| | |
| --- | --- |
| **Inbox & conversation view (dark)** ![Inbox, dark theme](docs/screenshots/inbox-dark.jpg) | **Inbox & conversation view (light)** ![Inbox, light theme](docs/screenshots/inbox-light.jpg) |
| **Reply composer** — identities, Reply-To, rich text, signature, quoted text ![Composer](docs/screenshots/compose.jpg) | **Calendar (month view)** ![Calendar](docs/screenshots/calendar.jpg) |
| **Contacts** ![Contacts](docs/screenshots/contacts.jpg) | **Sieve filter builder** — also reachable from a message's right-click menu ![Filters](docs/screenshots/filters.jpg) |
| **Sign-in** ![Login](docs/screenshots/login.jpg) | **Mobile layout** <img src="docs/screenshots/mobile.jpg" alt="Mobile" width="300"> |

## Features

**Mail**
- Gmail-style three-pane layout (reading pane right/bottom/off, **drag-to-resize splitter** in both orientations, quick layout switch in the list menu), conversation view with collapsed messages and "show quoted text", dense/cozy/comfortable density, light/dark/system theme with accent colours
- Virtualised, infinitely-scrolling message list; multi-select (click, ⇧-click, ⌃-click), drag & drop to folders, right-click context menus, hover actions, Gmail keyboard shortcuts (`j/k`, `e`, `#`, `r/a/f`, `g i`, `/`, `?` …)
- Archive / delete / spam / star / mark read / move / labels (IMAP keywords with colours) with **Undo**
- **"Filter messages like this…"** from the message context menu: creates a Sieve rule pre-filled from the sender/list (target folders can be created on the fly), and can **apply it immediately to the existing messages in the folder** (evaluated client-side, actions applied via JMAP)
- Safe HTML rendering: DOMPurify sanitisation inside a Shadow DOM, **remote images blocked by default** with a per-sender allow-list and an optional **privacy image proxy** (like Gmail's)
- Messages sit on a light card by default, untouched as the sender designed them. *Appearance › Apply the theme to messages too* lets them follow the app's light/dark theme instead — plain-text mail always does, and with the option on so does HTML mail that brings no colours of its own; mail that styles itself is still left alone
- Attachments: previews for images/PDF/text, download all, inline `cid:` images, `.eml` export, *Show original*, header viewer
- Invitations: `.ics` parts render as an invite card with **Yes/Maybe/No** RSVP (via `CalendarEvent/parse` + iTIP); `.vcf` parts offer *Add to contacts*; `List-Unsubscribe` one-click
- Search with Gmail operators (`from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `is:starred`, `in:`, `label:`, `before:`, `after:`, `larger:`, `smaller:` …) plus an advanced-search panel
- Composer: multiple floating/minimised/maximised composers, rich-text editor (formatting, lists, links, colours, images pasted/dropped inline, emoji), plain-text mode, recipient chips with autocomplete from **contacts, the directory (GAL) and recent recipients**, multiple identities with HTML signatures, Cc/Bcc, priority, read-receipt request, templates/canned responses, attachment upload with progress, drag & drop, attachment reminder, **undo send**, autosaved drafts, reply/reply-all/forward with quoting and inline images preserved
- Live updates via JMAP push (EventSource proxied server-side) with polling fallback; desktop notifications, sound, title/favicon unread badge
- A–Z folder list with Inbox pinned on top (other special folders mixed in), subfolders nested and collapsed by default with chevrons in their own gutter so every icon lines up; unread folders are bold (a parent is bold when a subfolder has unread mail); right-click a folder to mark it read *including subfolders*, create/rename/hide/share/empty, quota bar, Outlook-style module bar (Mail · Calendar · Contacts · Files) at the bottom of the pane, multi-account switching for shared accounts

**Calendar** (JMAP Calendars / JSCalendar)
- Month / week / day / agenda views, mini calendar, multiple calendars with colours, show/hide, create/edit/share calendars
- Create events by click or drag, edit everything: all-day, time zones, recurrence (presets + custom rule builder), location, meeting link, description, reminders, status/privacy/free-busy, colour
- Attendees with invitations (`sendSchedulingMessages`), RSVP, and **free/busy lookup** via `Principal/getAvailability`
- **Right-click menus** on events (open, edit, duplicate, colour, category, delete) and on empty slots/days (new event here, go to day/week)
- **Outlook-style colour categories**: named colours managed in Settings, assigned from the context menu or editor; stored as JSCalendar `categories` (+ `color`) so they sync

**Contacts** (JMAP Contacts / JSContact)
- Address books (create/rename/share/default), contact list with search and letter index, full contact editor (names, emails, phones, addresses, org/title, birthday, website, notes, photo), **groups**, vCard import/export, compose-to-contact

**Files** (JMAP FileNode)
- Browse folders, upload (drag & drop), download, create folders, rename, move, delete

**Settings**
- **Dates & times**: language/region (every one of the ~620 locales CLDR has data for, each named in its own language and script), date order (locale default, `22.11.2025`, `22/11/2025`, `11/22/2025` or ISO `2025-11-22`) and 12h/24h clock, applied everywhere — message list and headers, calendar, contacts, files, sessions. The default comes from the locale configured for the account in Stalwart (`x:Account/get`), falling back to the browser's; POSIX forms are normalised (`de_DE.UTF-8` → `de-DE`) and script modifiers preserved (`sr_RS@latin` → `sr-Latn-RS`). Numerals follow the locale (`٢٢.١١.٢٠٢٥` for `ar-EG`), except under ISO 8601, which pins date *and* clock to Latin digits
- Identities & signatures, **Sieve filters** (visual rule builder that round-trips to a Sieve script, plus a raw script editor with server-side validation), out-of-office (`VacationResponse`), folders, labels, templates, notifications, calendar defaults, sessions (sign out other devices), keyboard shortcuts, import/export of settings

**Platform**
- Installable PWA (manifest + service worker), mobile layout with bottom tab bar, drawer navigation, full-screen composer, FAB
- Security: no credentials in the browser (server-side session with per-session encrypted upstream credentials), httpOnly SameSite cookies, CSRF header + Sec-Fetch-Site checks, strict CSP, sandboxed blob downloads, SSRF-safe image proxy, login rate limiting, security headers

## Architecture

```
browser  ──(same-origin /api/*)──►  ihasmail server (Node + Hono)  ──(JMAP over HTTPS)──►  Stalwart
  React SPA                           • session cookie ⇄ Basic auth
  JMAP client + stores                • /api/jmap, /api/blob, /api/upload, /api/events (SSE), /api/image
```

- `web/` — Vite + React 19 + TypeScript SPA. `src/jmap` (client, push, types), `src/store` (zustand stores: session, mail, compose, contacts, calendar, files, sieve, settings), `src/views` (mail, compose, calendar, contacts, files, settings), `src/lib` (sanitiser, search parser, Sieve codec, dates and locale-aware formatting, vCard, …).
- `server/` — tiny Node/Hono backend: authenticates against Stalwart's JMAP session endpoint, stores the credentials sealed with a key derived from the cookie secret (the server never persists plaintext passwords), proxies JMAP/blob/SSE calls, serves the SPA with a strict CSP. Also contains `src/mock/` — an in-memory fake Stalwart for local development and demos.

Stalwart capabilities used: `core`, `mail`, `submission`, `vacationresponse`, `sieve`, `contacts`(+`parse`), `calendars`(+`parse`), `principals`(+`availability`), `quota`, `blob`, `filenode`, EventSource push, plus Stalwart's own `urn:stalwart:jmap` (read-only, for the account locale). Features degrade gracefully when a capability is missing.

## Quick start (Docker)

```bash
cp .env.example .env
# edit: STALWART_URL=https://mail.example.com  and  APP_SECRET=$(openssl rand -base64 48)
docker compose up --build -d
# → http://localhost:8080  (put Caddy/nginx in front for TLS; see Caddyfile.example / nginx.example.conf)
```

Users sign in with their Stalwart mailbox credentials (TOTP codes are supported via the "two-factor code" field, which Stalwart accepts as `password$code`).

## Development

Requirements: Node ≥ 20.10 (22 recommended), npm ≥ 10.

```bash
npm install

# against a real Stalwart (default: mail.inbuxa.com, change STALWART_URL in .env or the environment)
npm run dev            # server on :8080 (tsx watch) + Vite dev server on :5173 (proxying /api)

# against the built-in mock Stalwart (demo@example.com / demo) — no real mailbox needed
npm run dev:mock       # mock on :8788, server on :8080, Vite on :5173

npm run typecheck      # tsc for both packages
npm test               # vitest (web) + node:test (server)
npm run build          # web/dist + server/dist
npm start              # serve the production build
```

Open http://localhost:5173 in dev (or http://localhost:8080 for the production build).

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Description |
| --- | --- | --- |
| `STALWART_URL` | `https://mail.inbuxa.com` | Base URL of Stalwart; the JMAP session is discovered at `/.well-known/jmap` |
| `APP_SECRET` | *(required in production)* | Secret used to derive session encryption keys |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `TRUST_PROXY` | `1` | Honour `X-Forwarded-*` from a reverse proxy |
| `SECURE_COOKIES` | `auto` | `auto` (Secure on https), `1`, or `0` for plain-HTTP dev |
| `SESSION_TTL` / `SESSION_REMEMBER_TTL` | `43200` / `2592000` | Idle session lifetime (seconds), with/without "keep me signed in" |
| `SESSION_FILE` | *(unset)* | Persist sessions across restarts (ciphertext only) |
| `IMAGE_PROXY` | `1` | Route remote images through the privacy proxy |
| `MAX_UPLOAD_BYTES` | `52428800` | Upload size limit (Stalwart has its own limit too) |
| `APP_NAME` | `ihasmail` | Branding |

## Keyboard shortcuts

Press `?` anywhere. Highlights: `c` compose · `/` search · `j`/`k` navigate · `o`/`Enter` open · `u` back · `e` archive · `#` delete · `!` spam · `s` star · `r`/`a`/`f` reply/reply-all/forward · `v` move · `l` label · `x` select · `⇧I`/`⇧U` read/unread · `g i` inbox · `g l` calendar · `g c` contacts · `Ctrl+Enter` send.

## Known issues / pending QA

Verified against the mock server and, for the core mail flows, against a live Stalwart 1.0 (`mail.inbuxa.com`). Still pending live verification:

- **HTML signatures** — Stalwart caps identity signatures at 2 KB. ihasmail compacts pasted HTML, moves images to Files and, if still too large, keeps the full signature in Files behind a short marker (other clients see a text fallback). The end-to-end flow (save → compose → send with inline logo) is implemented but not yet confirmed on the live server.
- **Files** — the live server runs an older Stalwart build than `main`; `FileNode/query` there rejects `isTopLevel`/`parentId` filters, so ihasmail falls back to listing all nodes and building the tree client-side. Upload/rename/move/delete still need a live pass.
- Recurring events: colour/category/edit/delete apply to the whole series (per-occurrence overrides aren't supported by the server yet).
- Date **pickers** (`<input type="datetime-local">` in the event editor and out-of-office settings) are native browser controls and always follow the browser's own locale — no page can restyle them. The chosen format is echoed underneath the out-of-office fields so the entered instant is unambiguous.
- The account locale is read with Stalwart's `x:Account/get`, which needs the `sysAccountGet` permission; where a regular user is not granted it, ihasmail silently falls back to the browser locale and the setting can be chosen by hand.

## Roadmap / not yet

- Snooze and scheduled send (needs server-side support)
- Read-receipt (MDN) sending, S/MIME / OpenPGP
- Self-service password / app-password / 2FA management (Stalwart exposes this through its own account portal)
- Translations (strings are English-only for now)

## License

Copyright (C) 2026 LINUXexpert.org

ihasmail is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. See [LICENSE](LICENSE) for the full text.
