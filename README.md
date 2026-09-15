<p align="center">
  <img src="web/public/img/logo.png" alt="ihasmail" width="150">
</p>

<p align="center">
  <strong><a href="https://demo.ihasmail.com">Try the demo</a></strong><br>
  <sub>A working copy with an invented mailbox behind it — no sign-up, nothing real, nothing kept.</sub>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0-or-later" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-2dd4bf?style=flat-square"></a>
  <a href="https://stalw.art" target="_blank" rel="noreferrer"><img alt="Requires Stalwart 0.16 or newer; tested against 0.16.22" src="https://img.shields.io/badge/Stalwart-0.16.22-6366f1?style=flat-square"></a>
  <a href="https://docs.ihasmail.org" target="_blank" rel="noreferrer"><img alt="Documentation: docs.ihasmail.org" src="https://img.shields.io/badge/docs-docs.ihasmail.org-0ea5e9?style=flat-square"></a>
  <a href="https://coffeylabs.org" target="_blank" rel="noreferrer"><img alt="by Coffey Labs" src="https://img.shields.io/badge/by-Coffey%20Labs-0f766e?style=flat-square"></a>
</p>

# ihasmail

**Immutable webmail for [Stalwart Mail Server](https://stalw.art).** Mail,
calendars, contacts, files and filters in one app that works as well on a phone
as on a desktop — and a container with nothing to persist.

ihasmail talks only JMAP to Stalwart. There is no database, no IMAP or SMTP,
and with `IMMUTABLE=1` no writable filesystem either: everything durable,
settings included, belongs to Stalwart, so the container is disposable.

| | |
| --- | --- |
| 🌐 **[ihasmail.org](https://ihasmail.org)** | What it is, what it looks like, the full feature list |
| 📘 **[docs.ihasmail.org](https://docs.ihasmail.org)** | [Installing](https://docs.ihasmail.org/install/) · [Configuring](https://docs.ihasmail.org/configure/) · [Using it](https://docs.ihasmail.org/using/) · [Shortcuts](https://docs.ihasmail.org/shortcuts/) · [Rebranding](https://docs.ihasmail.org/rebranding/) · [Troubleshooting](https://docs.ihasmail.org/troubleshooting/) |
| 📋 **[FEATURES.md](FEATURES.md)** | Everything it does, feature by feature, with the capability each one needs |
| 🧪 **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)** | What was verified live, and where Stalwart departs from a spec |
| 🛣 **[ROADMAP.md](ROADMAP.md)** | What ihasmail does not do, and why |

## Screenshots

| | |
| --- | --- |
| **Inbox & conversation (dark)** ![Inbox, dark theme](docs/screenshots/inbox-dark.jpg) | **Inbox & conversation (light)** ![Inbox, light theme](docs/screenshots/inbox-light.jpg) |
| **Composer** ![Composer](docs/screenshots/compose.jpg) | **Calendar** ![Calendar](docs/screenshots/calendar.jpg) |
| **Contacts** ![Contacts](docs/screenshots/contacts.jpg) | **Sieve filter builder** ![Filters](docs/screenshots/filters.jpg) |

Taken against the built-in mock with sample data. More, including the phone
layout, on [ihasmail.org](https://ihasmail.org/#screenshots).

## What's in it

- **Mail** — conversations, labels, search operators, keyboard shortcuts, scheduled and undo send, invitations and RSVP, filters made from a message
- **Calendar** — month, week, day and agenda views, recurrence, attendees and free-busy
- **Contacts** — address books, groups, vCard import and export
- **Files** — browse, upload, move, share
- **Signature checking** — S/MIME signed mail verified as you read it
- **Settings that follow the account**, kept in the account's own storage on Stalwart
- **On a phone** — swipe to archive or delete, pull to refresh, hold to select
- **Administration** — a dashboard, accounts, groups, mailing lists, roles, tenants and domains, each shown only when the Stalwart role allows it
- **Ten interface languages and twelve themes** — the nine translations are marked Beta until a native speaker has read them
- **Platform** — installable PWA, Web Push, `mailto:` handler, no credentials in the browser, strict CSP

The long version is [FEATURES.md](FEATURES.md) and
[ihasmail.org](https://ihasmail.org/#features).

## Requirements

**Stalwart 0.16 or newer** — sign-in refuses anything older, by name. Tested
against 0.16.22; what changed in each release is in
[KNOWN-ISSUES.md](KNOWN-ISSUES.md).

- **No Stalwart yet?** [ihasmail-oneshot](https://github.com/Coffey-Labs/ihasmail-oneshot) deploys a new Stalwart and ihasmail together on one host, in one command.
- **On Stalwart 0.15?** [stalwart-migrator](https://github.com/Coffey-Labs/stalwart-migrator) upgrades it in place, or stay on the [`stalwart-0.15-support`](https://github.com/Coffey-Labs/ihasmail/releases/tag/stalwart-0.15-support) release.

## Quick start (Docker)

```bash
cp .env.example .env
# edit: STALWART_URL=https://mail.example.com  and  APP_SECRET=$(openssl rand -base64 48)
docker compose up --build -d
# → http://localhost:8080 — put a reverse proxy in front for TLS
```

Or pull the published image, `ghcr.io/coffey-labs/ihasmail`. Releases are
weekly, so it is usually a few days behind `main`.

People sign in with their Stalwart mailbox credentials. **An account with
two-factor authentication needs an app password**, created in Stalwart's own
settings.

Everything else — TLS, running immutably, several Stalwart servers, settings
the installation decides, every environment variable — is in
[Installing](https://docs.ihasmail.org/install/) and
[Configuring](https://docs.ihasmail.org/configure/).

## Development

```bash
npm install
npm run dev:mock     # built-in mock Stalwart (demo@example.com / demo)
npm test
```

Architecture, the mock's switches and how versions are numbered are in
[CONTRIBUTING.md](CONTRIBUTING.md#development-setup).

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) ·
[SECURITY.md](SECURITY.md) — please report vulnerabilities privately.

## License

Copyright (C) 2026 Coffey Labs — AGPL-3.0-or-later. See [LICENSE](LICENSE).

If you run a modified ihasmail, set `SOURCE_URL` to your own repository: the
sign-in page and Settings › About both show it. See
[Rebranding](https://docs.ihasmail.org/rebranding/).
