import os, secrets

APP_SECRET = os.getenv("APP_SECRET") or secrets.token_urlsafe(32)
COOKIE_NAME = os.getenv("COOKIE_NAME", "stalwart_webmail")
JMAP_BASE = os.getenv("JMAP_BASE", "https://mail.example.com/jmap")
CALDAV_BASE = os.getenv("CALDAV_BASE", "https://mail.example.com/caldav/")
WEBDAV_BASE = os.getenv("WEBDAV_BASE", "https://mail.example.com/webdav/")
TRUST_PROXY = os.getenv("TRUST_PROXY", "1") == "1"
UPSTREAM_TIMEOUT = float(os.getenv("UPSTREAM_TIMEOUT", "15"))
