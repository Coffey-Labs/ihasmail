# Roadmap / not yet

Things ihasmail does not do, and why. Anything with an issue number is tracked
in [the issue tracker](https://github.com/LINUXexpert-org/ihasmail/issues); the
rest is here because the answer is "no", not "not yet".

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for what is built but worth knowing about.

- Snooze (nothing in JMAP or Stalwart supports it, and ihasmail never stores a password, so nothing could act on a mailbox while you are away)
- Translations (strings are English-only for now)
- **Two-factor sign-in.** Today an account with 2FA must use an app password (see [Installing](https://docs.ihasmail.org/install/#checking-it-came-up)), and Settings › Security offers no way to switch 2FA *on* — only off, for an account that already has it. Supporting a TOTP code directly means implementing OAuth: Stalwart offers the authorization-code and device flows and no password grant, so ihasmail would hand sign-in to Stalwart's own login and come back with a token. That is a better security posture than the sealed password it holds now — a refresh token rather than a credential — but it replaces ihasmail's own sign-in page for those users and may need an OAuth client registered. Reported as [#75](https://github.com/LINUXexpert-org/ihasmail/issues/75)
