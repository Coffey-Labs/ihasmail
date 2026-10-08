# Security Policy

## Supported Versions

ihasmail is in maintenance mode: it receives security fixes, dependency updates, Stalwart compatibility fixes and small bug fixes, but no new features. Security fixes are applied to the latest release on the `main` branch. Older tags/releases are not guaranteed to receive backported fixes.

| Version       | Supported          |
| ------------- | ------------------ |
| `main` (latest) | :white_check_mark: |
| Older releases  | :x:                 |

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.** Public issues are visible to everyone, including potential attackers, before a fix is available.

Instead, report security issues privately in either of these ways:

- Email **securityATcoffeylabsDOTorg**
- Use [GitHub's private vulnerability reporting](https://github.com/Coffey-Labs/ihasmail/security/advisories/new) on the mirror

Please include as much of the following as you can:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof-of-concept
- The version/commit of ihasmail affected
- The version of Stalwart Mail Server you were testing against, if relevant
- Whether the issue is in ihasmail itself, in how it talks to Stalwart over JMAP, or in a dependency

### What to Expect

- **Acknowledgment:** You should receive a response within a few days confirming the report was received.
- **Assessment:** The issue will be triaged and its severity assessed. Because ihasmail holds no data of its own and relies entirely on Stalwart's store over JMAP, some reports may need to be routed to or coordinated with the [Stalwart Mail Server](https://github.com/stalwartlabs/mail-server) project if the root cause lives there rather than in ihasmail's client code.
- **Fix & disclosure:** Once a fix is ready, a new release will be published. We'll coordinate with you on public disclosure timing and credit, if you'd like to be credited.

### Scope

In scope:

- Authentication and session handling in ihasmail
- Cross-site scripting (XSS), CSRF, or injection issues in the webmail UI
- Improper handling of JMAP responses that could lead to data leakage between accounts
- Dependency vulnerabilities that are actually exploitable in ihasmail's usage

Out of scope (please report upstream instead):

- Vulnerabilities in Stalwart Mail Server itself — report those to the [Stalwart project](https://github.com/stalwartlabs/mail-server)
- Vulnerabilities in third-party libraries with no demonstrated impact on ihasmail
- Issues requiring physical access to a user's device or an already-compromised Stalwart instance

## Disclosure Policy

We follow coordinated disclosure: please give us a reasonable window to investigate and release a fix before any public disclosure. In turn, we'll keep you updated on progress and won't leave you waiting indefinitely.

Thank you for helping keep ihasmail and its users safe.
