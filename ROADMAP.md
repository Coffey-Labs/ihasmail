# Roadmap / not yet

Things ihasmail does not do, and why. An issue number here says where the entry
came from, not that it is tracked elsewhere — a report can be closed because the
bug in it was fixed while the larger thing it asked for stays on this page. What
is genuinely open lives in [the issue tracker](https://github.com/Coffey-Labs/ihasmail/issues);
the rest is here because the answer is "no", not "not yet".

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for what is built but worth knowing about.

- **Sharing a mail folder.** Stalwart stores the share and never delivers it; see [KNOWN-ISSUES.md](KNOWN-ISSUES.md). Withdrawn until the server does something with it. Sharing files, calendars and address books is unaffected and works.
- Snooze (nothing in JMAP or Stalwart supports it, and ihasmail never stores a password, so nothing could act on a mailbox while you are away)
- **Translations.** In progress, and the only entry here that is "not yet" rather than "no". The groundwork shipped in [#145](https://github.com/Coffey-Labs/ihasmail/pull/145): an interface-language setting separate from the date-and-time locale, `<html lang>` served from it, and the structural work that keeps a browser's own translator from rewriting the page underneath React. What is left is the part that was always the hard part — extracting every user-facing string, and having each catalogue read by somebody who speaks the language. A language is offered in Settings only once its catalogue is complete, so a half-translated build shows English and nothing else; the picker is the gate, not the calendar.

  Planned order, and it is an order rather than a wish list: **German, French, Dutch, Spanish, Portuguese (Brazil)** first, then **Russian, Ukrainian, Chinese (Simplified), Japanese**. Arabic, Hebrew and Persian are deliberately not on either list. They are right-to-left, and that is a layout and bidi problem rather than a longer catalogue — shipping them as though they were the same kind of work is how an RTL build ends up unusable and nobody says so.
- **Two-factor sign-in.** Today an account with 2FA must use an app password (see [Quick start](README.md#quick-start-docker)), and Settings › Security offers no way to switch 2FA *on* — only off, for an account that already has it. Supporting a TOTP code directly means implementing OAuth: Stalwart offers the authorization-code and device flows and no password grant, so ihasmail would hand sign-in to Stalwart's own login and come back with a token. That is a better security posture than the sealed password it holds now — a refresh token rather than a credential — but it replaces ihasmail's own sign-in page for those users and may need an OAuth client registered. Came out of [#75](https://github.com/Coffey-Labs/ihasmail/issues/75), which is closed: what was reported there was a sign-in refused with nothing but "Invalid credentials", and that was fixed by saying what is actually happening and pointing at app passwords. The OAuth work it uncovered is tracked here rather than as an open issue, so there is no ticket to watch for it.
