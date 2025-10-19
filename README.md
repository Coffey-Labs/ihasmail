# ihasmail

![ihasmail logo](app/static/img/logo.png)

A polished, FastAPI + HTMX/Jinja webmail for Stalwart, with JMAP mail/contacts/calendar, Sieve UI, DAV browsing, and reverse-proxy friendly deploy.

A production-leaning, **FastAPI** + **HTMX/Jinja** webmail for [Stalwart Mail Server](https://stalw.art/), using **JMAP** for mail, contacts, and calendar, plus simple **WebDAV/CalDAV** helpers. Authenticates with the user's Stalwart mailbox (like Roundcube). Designed to run behind a reverse proxy.

## Features
- Login with Stalwart mailbox (HTTP Basic against JMAP session or bearer token if provided)
- Inbox listing, read messages (plain text), compose & send via JMAP (`Email`, `EmailSubmission`)
- Contacts/Directory via JMAP `Contact`
- Calendar view via JMAP `CalendarEvent`
- WebDAV browser (read-only sample) and CalDAV endpoints (external DAV clients)
- CSRF on POST, signed session cookie, proxy-friendly
- Dockerfile + docker-compose for easy deploy

> HTML rendering and attachment streaming are stubbed—extend using the JMAP `downloadUrl` and sanitize HTML before display.

## Quick Start (Docker)

```bash
# 1) Configure environment
cp .env.example .env
# Edit JMAP_BASE, CALDAV_BASE, WEBDAV_BASE, APP_SECRET

# 2) Build & run
docker compose up --build -d

# 3) Reverse proxy (Nginx/Caddy) to http://127.0.0.1:8080
```

## Environment Variables
- `APP_SECRET` – random string for signing cookies (required)
- `JMAP_BASE` – e.g., `https://mail.example.com/jmap`
- `CALDAV_BASE` – e.g., `https://mail.example.com/caldav/`
- `WEBDAV_BASE` – e.g., `https://mail.example.com/webdav/`
- `COOKIE_NAME` – cookie name (default: `stalwart_webmail`)
- `TRUST_PROXY` – `1` to honor `X-Forwarded-*` (default: `1`)
- `UPSTREAM_TIMEOUT` – seconds for upstream HTTP (default: `15`)

## Dev
```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload
pytest
```

## Security & Hardening
- Prefer **bearer tokens** if Stalwart issues them; update `jmap_session()` to store `accessToken`
- Set explicit `accountId` from the JMAP session `primaryAccounts`
- Add mailbox/folder navigation via `Mailbox/query` + `Mailbox/get`
- Sanitize HTML bodies (e.g., `bleach`) before rendering
- Add Sieve UI via `urn:ietf:params:jmap:sieve`
- Consider rate limiting and security headers in the reverse proxy
- Serve static assets via proxy/CDN

## License
GPL-3.0-or-later
