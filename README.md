<p align="center">
  <img src="web/public/img/logo.png" alt="ihasmail" width="150">
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence: AGPL-3.0-or-later" src="https://img.shields.io/badge/licence-AGPL--3.0--or--later-2dd4bf?style=flat-square"></a>
  <a href="https://stalw.art" target="_blank" rel="noreferrer"><img alt="Requires Stalwart 0.16 or newer; tested against 0.16.19" src="https://img.shields.io/badge/Stalwart-0.16.19-6366f1?style=flat-square"></a>
  <a href="https://linuxexpert.org" target="_blank" rel="noreferrer"><img alt="by LINUXexpert.org" src="https://img.shields.io/badge/by-LINUXexpert.org-0f766e?style=flat-square"></a>
</p>

# ihasmail

**A fast, friendly, Gmail-class webmail for [Stalwart Mail Server](https://stalw.art) — built on JMAP, from the ground up.**

ihasmail is a JMAP-first web client: mail, calendars, contacts, files, filters and every other modern feature Stalwart exposes, in a responsive single-page app that works equally well on a desktop monitor and a phone. It talks only JMAP (plus Stalwart's blob/upload/EventSource endpoints) — no IMAP, no SMTP, no database.

> Status: 2.0 rewrite, in QA against a live Stalwart server — **0.16.19**
> since 2026-08-25. The previous FastAPI/HTMX prototype
> has been removed entirely (only the logo survived, and it has since lost
> the `.com` wordmark it used to carry — ihasmail is the software, not the
> hosted instance).

**ihasmail requires Stalwart 0.16 or newer.** Sign-in refuses anything older,
by name, rather than letting Files and credentials fail separately with
nothing to connect them.

It used to support 0.15 as well. The two are less alike than the version
numbers suggest — 0.16 replaced the REST management API with JMAP registry
objects, changed the shape of `FileNode`, split its rights up, and moved
configuration into the store — and carrying both meant every call site had to
ask which one it was talking to. The cost was not the branches. It was that a
wrong answer had somewhere to fall back to, so it failed *quietly*: one
capability looked for in the wrong place downgraded every real 0.16 server to
the 0.15 path, and that reached production. With one supported generation a
wrong guess is a loud error on the first call instead.

The last release that runs on 0.15 is tagged
[`stalwart-0.15-support`](https://github.com/LINUXexpert-org/ihasmail/releases/tag/stalwart-0.15-support),
if you are on 0.15 and cannot upgrade yet.

The live instance was moved from 0.15.5 to 0.16.19 with
[stalwart-migrator](https://github.com/LINUXexpert-org/stalwart-migrator), a
companion project: an in-place upgrade tool that checkpoints every phase,
refuses to start on the things that cannot be fixed mid-migration, and
validates the server afterwards. The upgrade is genuinely treacherous by hand
— the store is migrated in place with no way back, and Stalwart's own
converter drops settings without saying so — and that migration took eight
seconds of downtime with nothing lost.

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
- **Read receipts**: when a sender asks for one, the message offers to send it — a real RFC 8098 `multipart/report`, never automatically. Bulk mail, mailing lists and anything marked `Auto-Submitted` are not offered one at all, and a receipt aimed somewhere other than the sender says so before you send it. Sending is recorded with RFC 3503's `$mdnsent` keyword, so a second look — or another client — knows not to ask again
- Invitations: `.ics` parts render as an invite card with **Yes/Maybe/No** RSVP (via `CalendarEvent/parse` + iTIP); `.vcf` parts offer *Add to contacts*; `List-Unsubscribe` one-click
- **Right-click anyone named in a message** — sender, To, Cc, Bcc, Reply-To — to add them to the address book (the contact editor opens prefilled, with the display name split into first/last), edit them if they are already known, write to them, or copy the address
- Search with Gmail operators (`from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `is:starred`, `in:`, `label:`, `before:`, `after:`, `larger:`, `smaller:` …) plus an advanced-search panel
- Composer: multiple floating/minimised/maximised composers, rich-text editor (formatting, lists, links, colours, images pasted/dropped inline, emoji), plain-text mode, recipient chips with autocomplete from **contacts, the directory (GAL) and recent recipients**, multiple identities with HTML signatures, Cc/Bcc, priority, read-receipt request, templates/canned responses, attachment upload with progress, drag & drop, attachment reminder, **undo send**, **scheduled send** (quick picks or an exact date and time; the message waits in the server's queue, so it goes out whether or not ihasmail is open), autosaved drafts, reply/reply-all/forward with quoting and inline images preserved
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
- **Dates & times**: language/region (every one of the ~620 locales CLDR has data for, each named in its own language and script), date order (locale default, `22.11.2025`, `22/11/2025`, `11/22/2025` or ISO `2025-11-22`) and 12h/24h clock, applied everywhere — message list and headers, calendar, contacts, files, sessions. The default comes from the locale configured for the account in Stalwart (`x:AccountSettings/get`, falling back to `x:Account/get`), and from the browser where the server will not say; POSIX forms are normalised (`de_DE.UTF-8` → `de-DE`) and script modifiers preserved (`sr_RS@latin` → `sr-Latn-RS`). Numerals follow the locale (`٢٢.١١.٢٠٢٥` for `ar-EG`), except under ISO 8601, which pins date *and* clock to Latin digits. Dates are **entered** through custom pickers in the same format (browsers render `<input type="date">` in their own locale and ignore the page's), with a calendar popover, a time list, keyboard navigation, and lenient typing — `22.11.`, `221125`, `6:23pm` and bare ISO all parse
- **Self-service credentials** in Settings › Security: change your password, manage **app passwords** (a separate password per mail app or device, revocable on its own), and turn **two-factor authentication** on or off by scanning a QR code. Enrolment codes are verified before anything is stored, so a mistyped key cannot lock you out, and switching 2FA on moves this browser's session onto a dedicated app password instead of signing you straight back out. Built on the `x:AccountPassword` / `x:AppPassword` registry objects
- **Light and dark** follow the system by default, with a toggle in the top bar for flipping between them and a three-way choice in Settings › Appearance
- Identities & signatures, **Sieve filters** (visual rule builder that round-trips to a Sieve script, plus a raw script editor with server-side validation), out-of-office (`VacationResponse`), folders, labels, templates, notifications, calendar defaults, sessions (sign out other devices), keyboard shortcuts, import/export of settings
- **Settings follow the account, not the browser**: they are kept in a `settings.json` in the account's own JMAP Files, so the default identity, locale, date and time formats, theme, labels, templates, folder colours and the rest are the same wherever you sign in — including a private window. ihasmail still stores nothing itself; the file lives in the mail store and is backed up with it. Settings that describe *this* screen or browser stay local, because syncing them would be wrong rather than helpful: list-pane sizes, density, font size, sidebar state, and the notification toggles (which track a permission the browser grants per-device). localStorage is kept as a cache so the first frame is already right, and the file corrects it a moment later

**Platform**
- Installable PWA (manifest + service worker), mobile layout with bottom tab bar, drawer navigation, full-screen composer, FAB
- **Default mail app**: register ihasmail as the browser's handler for `mailto:` links from Settings › General (`registerProtocolHandler`; needs HTTPS and a browser that supports it — Safari does not). Installed as an app it also declares `protocol_handlers` in the manifest, which is what lets the operating system offer ihasmail wherever it asks for a mail client. Links arrive with recipients, Cc, Bcc, subject and body filled in
- **About** reports the Stalwart generation ihasmail detected (0.16+ or older) and the edition where the server gives one. Stalwart does not publish a version number to clients, so no version is shown rather than a made-up one
- Security: no credentials in the browser (server-side session with per-session encrypted upstream credentials), httpOnly SameSite cookies, CSRF header + Sec-Fetch-Site checks, strict CSP, sandboxed blob downloads, SSRF-safe image proxy, login rate limiting, security headers

## Architecture

```
browser  ──(same-origin /api/*)──►  ihasmail server (Node + Hono)  ──(JMAP over HTTPS)──►  Stalwart
  React SPA                           • session cookie ⇄ Basic auth
  JMAP client + stores                • /api/jmap, /api/blob, /api/upload, /api/events (SSE), /api/image
```

- `web/` — Vite + React 19 + TypeScript SPA. `src/jmap` (client, push, types), `src/store` (zustand stores: session, mail, compose, contacts, calendar, files, sieve, settings), `src/views` (mail, compose, calendar, contacts, files, settings), `src/lib` (sanitiser, search parser, Sieve codec, dates and locale-aware formatting, vCard, …).
- `server/` — tiny Node/Hono backend: authenticates against Stalwart's JMAP session endpoint, stores the credentials sealed with a key derived from the cookie secret (the server never persists plaintext passwords), proxies JMAP/blob/SSE calls, serves the SPA with a strict CSP. Also contains `src/mock/` — an in-memory fake Stalwart for local development and demos.

Stalwart capabilities used: `core`, `mail`, `submission`, `vacationresponse`, `sieve`, `contacts`(+`parse`), `calendars`(+`parse`), `principals`(+`availability`), `quota`, `blob`, `filenode`, EventSource push, plus Stalwart's own `urn:stalwart:jmap` (read-only, for the account locale and to tell the generations apart). Features degrade gracefully when a capability is missing.

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

# against a real Stalwart (set STALWART_URL in .env or the environment)
npm run dev            # server on :8080 (tsx watch) + Vite dev server on :5173 (proxying /api)

# against the built-in mock Stalwart (demo@example.com / demo) — no real mailbox needed
npm run dev:mock       # mock on :8788, server on :8080, Vite on :5173

# the same, with the mock advertising FUTURERELEASE but dropping every hold —
# the shape of a real server whose `futureRelease` setting was never turned on
npm run dev:mock:no-future-release

npm run typecheck      # tsc for both packages
npm test               # vitest (web) + node:test (server)
npm run build          # web/dist + server/dist
npm start              # serve the production build
```

Open http://localhost:5173 in dev (or http://localhost:8080 for the production build).

### Version numbers

`ihasmail v2.16.57`, shown on the sign-in page, in Settings › About, and by `/api/health`:

| | |
| --- | --- |
| `2` | ihasmail's own major |
| `16` | the **Stalwart** generation this build targets — 0.16, the oldest it supports |
| `57` | the pull request the commit came from |

The first two live in the root `package.json`, so there is one place to bump
them; `16` becomes `17` when ihasmail moves to Stalwart 0.17. The third comes
from git at build time, because it does not exist until the pull request has
merged — a version committed to the tree would always be describing a merge
that had not happened yet, and every open branch would collide on the same
line. Nothing writes one back.

A commit that did not arrive through a pull request carries the last number
plus its own short SHA — `2.16.57+g1fa6578` — which says plainly that the build
is *past* that pull request rather than being it.

`node scripts/version.mjs` prints the version for the current checkout.

`.dockerignore` excludes `.git` deliberately, so an image build cannot work any
of this out for itself. Pass it in:

```bash
docker build --build-arg IHASMAIL_VERSION="$(node scripts/version.mjs)" -t ihasmail:2.16 .
```

Left out, the build falls back to the base version from `package.json`
(`2.16.0`) rather than failing — so a version with no PR number on it means
whoever built the image did not pass one.

### The mock

`npm run mock` is an in-memory fake Stalwart 0.16 — enough of JMAP to develop
and demo against without a real mailbox. It models the things a real server
does that a naive fake would not, because each of these cost a live debugging
session to find:

- `urn:stalwart:jmap` is advertised **per-account**, in `primaryAccounts` and
  each account's `accountCapabilities`, and never in the session-level
  `capabilities`. That is where Stalwart actually puts it, and a client that
  tests for it in the obvious place concludes it is talking to something far
  older than it is. The mock used to advertise it in the wrong place, which is
  exactly why nothing caught that bug
- identity signatures are capped at 2047 **bytes**, not characters
- `CalendarEvent/set` uses Stalwart's vocabulary, not RFC 8984's, and refuses
  what the real server refuses — advertising the RFC spelling is how that one
  reached a live server
- `MOCK_NO_FUTURE_RELEASE=1` (or `npm run mock:no-future-release`) advertises
  FUTURERELEASE and then drops every hold, which is the shape of a real server
  whose `futureRelease` setting was never turned on
- `MOCK_NO_REGISTRY=1` omits the Stalwart capability, so the sign-in refusal
  for unsupported servers can be tested. That is all it does — the rest still
  behaves like 0.16. Emulating 0.15 properly went with the support for it

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Description |
| --- | --- | --- |
| `STALWART_URL` | `https://mail.example.com` | Base URL of Stalwart; the JMAP session is discovered at `/.well-known/jmap` |
| `APP_SECRET` | *(required in production)* | Secret used to derive session encryption keys |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `TRUST_PROXY` | `1` | Honour `X-Forwarded-*`, but only from a peer listed in `TRUSTED_PROXIES` |
| `TRUSTED_PROXIES` | *(loopback + private ranges)* | Comma-separated CIDRs or addresses whose forwarding headers are believed. Anything else is attributed by its socket address, whatever it claims |
| `SECURE_COOKIES` | `auto` | `auto` (Secure on https), `1`, or `0` for plain-HTTP dev |
| `SESSION_TTL` / `SESSION_REMEMBER_TTL` | `43200` / `2592000` | Idle session lifetime (seconds), with/without "keep me signed in" |
| `SESSION_FILE` | *(unset)* | Persist sessions across restarts (ciphertext only) |
| `IMAGE_PROXY` | `1` | Route remote images through the privacy proxy |
| `MAX_UPLOAD_BYTES` | `52428800` | Upload size limit (Stalwart has its own limit too) |
| `APP_NAME` | `ihasmail` | Branding |

## Keyboard shortcuts

Press `?` anywhere. Highlights: `c` compose · `/` search · `j`/`k` navigate · `o`/`Enter` open · `u` back · `e` archive · `#` delete · `!` spam · `s` star · `r`/`a`/`f` reply/reply-all/forward · `v` move · `l` label · `x` select · `⇧I`/`⇧U` read/unread · `g i` inbox · `g l` calendar · `g c` contacts · `Ctrl+Enter` send.

## Known issues / pending QA

The live instance runs **0.16.19**, and everything below says what has been
checked against it and what has not.

Some entries record what a live **0.15.5** proved before that server was
upgraded on 2026-08-25. They are kept where the finding is about ihasmail
rather than about 0.15 — a byte cap that still applies, a flow that still
works the same way — and dropped where 0.15 was the whole subject. Support for
0.15 was removed on 2026-08-26; the last release that runs on it is tagged
[`stalwart-0.15-support`](https://github.com/LINUXexpert-org/ihasmail/releases/tag/stalwart-0.15-support).

- **Read receipts are built here, not by the server** — JMAP has an extension for them, [RFC 9007](https://www.rfc-editor.org/rfc/rfc9007.html)'s `MDN/send`, and Stalwart does not implement it: `urn:ietf:params:jmap:mdn` is not among its capabilities. So ihasmail assembles the `multipart/report` itself and sends it the long way round — raw MIME uploaded as a blob, `Email/import`, then `EmailSubmission` — which is also why the receipt lands in Sent, where it honestly belongs. Non-ASCII parts are base64 rather than `8bit`, so nothing depends on 8BITMIME surviving every hop. There is deliberately no "always send" setting: a receipt confirms to whoever asked that the address is live and when it was read, to an address of the sender's choosing, so each one is a decision. Verified against the mock end to end (upload, import, submit, `$mdnsent`); **not yet exercised against the live server**.
- **Where 0.16 advertises `urn:stalwart:jmap`** — not where a JMAP client would look, and this now decides whether a sign-in is allowed at all. Stalwart builds the session-level `capabilities` from a fixed list (`Session::new`, plus WebSocket) that has never contained this capability, in any 0.16.x from 0.16.0 to 0.16.19. It hands it out per-account instead, so it appears in `primaryAccounts` and in each account's `accountCapabilities`. ihasmail tested for it in `capabilities` alone, which made every real 0.16 server read as older than 0.16 — and that one check drove three things: self-service credentials fell back to `POST /api/account/auth`, which 0.16 removed, so password changes, 2FA and app passwords all failed with "this mail server does not offer self-service credential management"; About reported the wrong generation; and Files took the older code path. It now looks in all three places, and is covered by tests on each. Worth restating plainly, because the stakes went up when 0.15 support was dropped: there is no longer a fallback path for this check to be wrong *into*. Getting it wrong now refuses every sign-in against a perfectly good server — a loud failure rather than a quiet misrouting, which is the trade the removal was making.
- **HTML signatures** — Stalwart caps a signature at 2047 **bytes** (`value.len() < 2048` on a Rust string, so UTF-8 bytes, not characters). ihasmail compacts pasted HTML, moves images to Files and, if still too large, keeps the full signature in Files behind a short marker; other clients see a text fallback. Confirmed live on 0.15.5 (2026-08-24): oversized, non-ASCII and inline-image signatures all save, and a test message arrived intact at Gmail with the logo inline.
- **Settings live in the account's Files, not the browser** — every preference used to sit in `localStorage`, so none of them followed anyone between devices. The sharpest edge was the default identity: with none set the address that sorts first wins, so someone who set it at work found it unset at home and mail went out from an address the recipient might not recognise ([#54](https://github.com/LINUXexpert-org/ihasmail/issues/54)). They are now a `settings.json` in the `ihasmail` folder in JMAP Files, beside the signature images already kept there — which keeps ihasmail itself stateless: no volume, no database, nothing to back up separately, and the settings are covered by whatever backs up the mail store. `x:AccountSettings` was the other candidate and does not fit; its schema is `locale`/`timeZone`/`description` with no free-form field, and writing it needs `sysAccountSettingsSet`, where the built-in user role carries only the `…Get` half. `localStorage` stays on as a *cache* rather than the source of truth, so the first frame paints from it and the file corrects it a moment later; a browser with no cache shows defaults for that one frame, which is the trade for not gating the whole app on a round trip. Settings that describe *this* screen or browser deliberately stay local — list-pane sizes, density, font size, sidebar state, and the notification toggles, which track a permission the browser grants per-device and would be a claim about somewhere else it cannot make. That split is written as a list of exceptions, so a setting added later syncs by default. Writes are coalesced behind a three-second debounce, since `update()` fires on every frame of a splitter drag, and a tab going away or a sign-out flushes first. The `ihasmail` folder is now hidden from the Files view, contents and all: hiding the folder alone would be worse than showing it, because the tree attaches a node whose parent is missing to the root, so the signature images — visible there since signatures shipped — would have spilled into the top level. **Confirmed live on 0.16.19 (2026-08-26)**: settings set in Chrome came back on a fresh login in Firefox and in an incognito session, both of which start with an empty cache, so each read the account's file rather than anything local. Requires 0.16, which ihasmail now requires everywhere — `FileNode/query` cannot see directories before that, and sign-in refuses an older server outright. Two limits worth knowing: conflicts are last-write-wins, and a change made on one device does not reach another that already has ihasmail open until it signs in again.
- **Files on 0.16** — the pre-0.16 quirks this entry used to describe are gone with the support for them: `FileNode/query` masking directories out of its own results, `nodeType` not existing, and rights being a single `mayWrite`. What is left is what has actually been exercised on 0.16.19. Finding and creating a folder, creating a node with `nodeType`, uploading and downloading its blob, and pointing an existing node at a new one all ran live on 2026-08-26, as a side effect of the settings file. **Rename, move, delete and the Files view itself are still unchecked on 0.16** — what was confirmed live on 0.15.5 (2026-08-24) was the older code path, which no longer exists. Two fallbacks went with the removal and are worth knowing about: `ensureFolder` and `findInFolder` now filter on `parentId`/`isTopLevel` alone and match names client-side, since `name` is not a filter Stalwart is known to implement and one it does not know fails the whole query; and a refused filter or sort no longer drops the view into fetching every node in the account, which would have hidden a real fault behind a performance cliff nobody would notice.
- **Self-service credentials** — the registry path is **confirmed live** against Stalwart 0.16.19 (2026-08-25): app passwords created and revoked, password changed, 2FA enabled and disabled, with the browser session surviving the switch to an app password. The 0.15 REST path was confirmed live too, on 0.15.5 (2026-08-24), and has since been removed along with the rest of 0.15 support. The mock enforces the same rules the real server does (current password required, password policy, a TOTP code on every request once 2FA is on, app passwords exempt from it). Password changes are refused by Stalwart for accounts backed by an external directory (LDAP/SQL/OIDC); the server's own message is shown when that happens.
- **Scheduled send needs one setting turned on, and says nothing when it is off.** Stalwart advertises the delay in the account's `urn:ietf:params:jmap:submission` capability — `maxDelayedSend: 2592000` (30 days) and `FUTURERELEASE` among its `submissionExtensions`, and note it is the *account* capability, not the session-level one, which is empty. But the MTA only honours a hold when `futureRelease` is set under the session's MTA extensions, and [that setting defaults to `false`](https://stalw.art/docs/ref/object/mta-extensions/). With it off, Stalwart takes the `HOLDUNTIL` parameter, skips the hold and sends the message immediately **without an error** — the capability still says thirty days. So set `futureRelease` (to the longest hold you want to allow) before relying on this; a value shorter than 30 days is fine, and a request past it is refused honestly, with a `forbiddenMailFrom` naming the limit. `npm run dev:mock:no-future-release` reproduces the silent-drop case. ihasmail asks for the delay the way JMAP requires — a `HOLDUNTIL` parameter on the envelope's `mailFrom`, since RFC 8621 makes `sendAt` read-only and server-derived — and files the held message in a **Scheduled** folder, because `onSuccessUpdateEmail` would otherwise drop it in Sent the moment the submission is created. Nothing moves it out when the hold expires, so ihasmail reconciles the folder on the way in: released messages to Sent, cancelled ones back to Drafts. Three fixes this depends on landed in **0.16.17**, below the live instance's 0.16.19: `HOLDUNTIL` taking RFC 3339 date-times again (0.16.16 had it wanting Unix timestamps), `EmailSubmission/query` on `undoStatus` agreeing with `/get` about held submissions, and `EmailSubmission/get` without `ids` iterating the right index. The hold itself is now **confirmed against the live 0.16.19** (2026-08-25), once `futureRelease` was set to `30d` there: a submission carrying a `HOLDUNTIL` ten minutes out came back `pending`, with `sendAt` equal to the time asked for and a `250 2.1.5 Queued` from the MTA, rather than going out at once. Worth repeating that the capability is no evidence either way — it advertised `maxDelayedSend: 2592000` and `FUTURERELEASE` while the setting was still off. Only a submission tells you. What is still mock-only is the rest of the journey: the **Scheduled** folder reconciling on the way in, and a hold actually expiring and being delivered.
- **Stalwart 0.16 and RFC 8984 disagree about the calendar vocabulary, and the server only says so half the time.** A participant's address lives in `calendarAddress`, not RFC 8984's `sendTo`/`email`; the organizer is `organizerCalendarAddress`, not `replyTo`; and a recurrence is a single `recurrenceRule`, not a `recurrenceRules` array. Addressed the RFC's way, `CalendarEvent/set` **keeps the event and discards the whole participant map without an error** — guests disappeared on save and no invitation was ever sent, which is what [#26](https://github.com/LINUXexpert-org/ihasmail/issues/26) reported. The array form of the rule is refused honestly, with `invalidProperties`, so recurring events could not be created at all and existing ones showed no repeat ([#30](https://github.com/LINUXexpert-org/ihasmail/issues/30)). ihasmail now writes Stalwart's names and reads either, and the mock refuses what the real server refuses, since advertising the RFC spelling is precisely how this got as far as a live server. Verified against 0.16.19 on 2026-08-25, end to end: participants, organizer and rule all survive a create, an update and a re-read; an invitation to an external Gmail address arrived as an invite card, and the decline came back and was applied to the event (`needs-action` → `declined`, sequence 1). Cancelling the event notified the guest too. Adding guests to an event that had none, and clearing them again with `null`, both work on the update path, as does RSVP — which patches `participants/{key}/participationStatus` (and `participationComment`) rather than sending the whole map. That patch has to be aimed at the base event: `CalendarEvent/set` refuses a synthetic id with *"Updating synthetic ids is not yet supported"*, which is why RSVP resolves `baseEventId` first. Adding a *new* participant by patch is refused as well (`Patch operation failed`), so a changed guest list is written as the whole `participants` property. One more thing to know when reading this code: an expanded occurrence carries a `recurrenceId` but *no* rule of its own, and `baseEventId` is set on everything an expanded query returns — a one-off included, whose own id differs from its base — so neither is a test for recurrence.
- Recurring events: colour/category/edit/delete apply to the whole series (per-occurrence overrides aren't supported by the server yet).
- Editable date boxes are always Gregorian and in Latin digits, even for locales whose *display* uses another calendar or numbering system (`fa-IR`, `th-TH`, `ar-EG`) — they keep the locale's field order and separator, but a Buddhist-era year in a text box does not round-trip against the Gregorian calendar grid. Non-Gregorian calendar support is not implemented.
- The account locale is read from `x:AccountSettings/get`, whose permission the built-in user role has, falling back to `x:Account/get` (which needs the admin-only `sysAccountGet`). Both are Stalwart 0.16 methods: **on older servers neither is reachable** — they do not implement the registry and reject a request that so much as names the `urn:stalwart:jmap` capability — so there the locale still falls back to the browser's and can be chosen by hand. Confirmed live on 0.16.19 (2026-08-25), once the capability was looked for where Stalwart advertises it; a locale request that is merely refused no longer downgrades the detected generation.

## Roadmap / not yet

- Snooze (nothing in JMAP or Stalwart supports it, and ihasmail never stores a password, so nothing could act on a mailbox while you are away)
- Translations (strings are English-only for now)

## License

Copyright (C) 2026 LINUXexpert.org

ihasmail is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. See [LICENSE](LICENSE) for the full text.

ihasmail was relicensed from GPL-3.0 to AGPL-3.0 on 2026-08-25. Webmail is
nearly always run as a network service rather than handed to anyone as a
binary, and the AGPL's section 13 closes that gap: anyone running a modified
ihasmail for other people has to offer them its source, which the GPL alone
does not require.

That offer has to point at *your* source, not this one. If you run a modified
ihasmail, set `SOURCE_URL` to your own repository: the sign-in page and
Settings › About both show it, so the people using your instance are told where
the code they are actually running can be found.
