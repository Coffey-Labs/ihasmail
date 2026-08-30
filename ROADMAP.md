# Roadmap / not yet

Things ihasmail does not do, and why. An issue number here says where the entry
came from, not that it is tracked elsewhere — a report can be closed because the
bug in it was fixed while the larger thing it asked for stays on this page. What
is genuinely open lives in [the issue tracker](https://github.com/Coffey-Labs/ihasmail/issues);
the rest is here because the answer is "no", not "not yet".

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for what is built but worth knowing about.

- **Sharing a mail folder.** Stalwart stores the share and never delivers it; see [KNOWN-ISSUES.md](KNOWN-ISSUES.md). Withdrawn until the server does something with it. Sharing files, calendars and address books is unaffected and works.
- Snooze (nothing in JMAP or Stalwart supports it, and ihasmail never stores a password, so nothing could act on a mailbox while you are away)
- Translations (strings are English-only for now)
- **Two-factor sign-in.** Today an account with 2FA must use an app password (see [Quick start](README.md#quick-start-docker)), and Settings › Security offers no way to switch 2FA *on* — only off, for an account that already has it. Supporting a TOTP code directly means implementing OAuth: Stalwart offers the authorization-code and device flows and no password grant, so ihasmail would hand sign-in to Stalwart's own login and come back with a token. That is a better security posture than the sealed password it holds now — a refresh token rather than a credential — but it replaces ihasmail's own sign-in page for those users and may need an OAuth client registered. Came out of [#75](https://github.com/Coffey-Labs/ihasmail/issues/75), which is closed: what was reported there was a sign-in refused with nothing but "Invalid credentials", and that was fixed by saying what is actually happening and pointing at app passwords. The OAuth work it uncovered is tracked here rather than as an open issue, so there is no ticket to watch for it.
