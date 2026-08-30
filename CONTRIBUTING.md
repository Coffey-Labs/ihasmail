# Contributing to ihasmail

Thanks for your interest in contributing to **ihasmail** — a Gmail-style, JMAP-only webmail client for [Stalwart Mail Server](https://stalw.art/). Contributions of all kinds are welcome: bug reports, feature requests, code, documentation, and testing.

## Code of Conduct

By participating in this project, you agree to treat other contributors with respect. Be constructive, be patient with newcomers, and keep discussion focused on the project. Harassment or abusive behavior toward other contributors will not be tolerated.

## Before You Start

- ihasmail speaks **JMAP only** — it does not support IMAP/POP3/SMTP fallback paths. Keep this in mind when proposing features.
- ihasmail has **no database of its own** — all state lives in Stalwart via JMAP. Contributions should not introduce a separate persistence layer without discussion first.
- This project is licensed under **AGPL-3.0**. Any code you contribute will be distributed under this license, including for hosted/SaaS deployments.

## How to Contribute

### Reporting Bugs

Before opening a new issue, please search [existing issues](https://github.com/Coffey-Labs/ihasmail/issues) to see if it's already been reported. When filing a bug report, include:

- A clear, descriptive title
- Steps to reproduce the issue
- Expected behavior vs. actual behavior
- Your environment: browser/OS, Stalwart version, and how ihasmail is deployed (Docker, bare metal, etc.)
- Relevant logs, console errors, or screenshots
- Whether the issue is reproducible against a fresh Stalwart instance

### Suggesting Features

Open an issue describing:

- The problem you're trying to solve (not just the solution)
- How it fits with ihasmail's JMAP-only, Gmail-style design philosophy
- Any relevant JMAP RFC references (RFC 8620, RFC 8621) if the feature touches protocol behavior

For larger changes, please open an issue to discuss the approach **before** submitting a pull request — this saves everyone time if the direction needs adjusting.

### Submitting Pull Requests

1. **Fork** the repository and create your branch from `main`.
2. **Name your branch** descriptively, e.g. `fix/thread-view-scroll` or `feat/search-filters`.
3. **Keep PRs focused** — one logical change per PR. Large, unrelated changes bundled together are harder to review and more likely to be rejected.
4. **Write clear commit messages** describing what changed and why.
5. **Test your changes** against a real (or local) Stalwart instance where possible, since JMAP behavior can be subtle.
6. **Update documentation** if your change affects setup, configuration, or user-facing behavior.
7. **Open the pull request** against `main`, filling out the PR template with:
   - A summary of the change
   - Related issue number(s), if any
   - Screenshots/GIFs for UI changes
   - Any manual testing you performed

### Code Style

- Match the existing formatting and naming conventions used elsewhere in the codebase.
- Keep functions small and single-purpose where practical.
- Prefer clarity over cleverness — this is a mail client people rely on for their inbox.
- Comment non-obvious JMAP interactions, especially around state/`changes` handling, since JMAP's delta-sync model can be easy to get subtly wrong.

### Development Setup

1. Clone your fork:
   ```bash
   git clone https://github.com/YOUR-USERNAME/ihasmail.git
   cd ihasmail
   ```
2. Point your local instance at a running Stalwart Mail Server (a test/dev instance is strongly recommended — do not develop against a production mailbox).
3. Follow the setup instructions in the repository's `README.md` for installing dependencies and running the app locally.
4. Verify your changes don't break existing JMAP calls by exercising core flows: login, list/read mail, send, search, and folder/label operations.

## Review Process

- A maintainer will review your PR and may request changes.
- Please respond to review feedback in a timely manner; PRs with no activity for an extended period may be closed and can be reopened once updated.
- Once approved, a maintainer will merge the PR.

## Reporting Security Issues

Please **do not** open a public issue for security vulnerabilities. Instead, report them privately by emailing **johnellisATlinuxDOTcom** with details of the issue. See `SECURITY.md` if one is present in the repo for further instructions.

## Questions?

If you're unsure whether something is a good fit, open an issue and ask — discussion is welcome before you invest time in a PR.

Thanks again for helping improve ihasmail!
