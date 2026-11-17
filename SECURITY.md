# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and
choose **Report a vulnerability**. Only the maintainers can see the report.

If that button is not available, open an ordinary issue that says only that you have a
security report and asks for a private contact. Leave out the details.

Helpful things to include:

- What the problem is and what an attacker could do with it.
- The Conduit version (or commit) and your Windows version.
- Steps to reproduce, or a proof of concept.

We aim to acknowledge a report within a week and will keep you updated while we work on a
fix. Unless you would rather stay anonymous, the release notes for the fix will credit you.

## Supported versions

Only the latest release gets security fixes. Please update before reporting.

## Scope

In scope: the Conduit desktop app, the Discord bot, and the packages in this repository,
including how they store your Steam, Discord and server credentials.

Out of scope: Facepunch's Rust+ servers and companion API, Discord, Steam, and Google's
push service. Please report problems in those to their owners.

## Checking a download

Every release is built by GitHub Actions from the tagged source. See
[Verifying your download](docs/verifying-your-download.md) for how to check the
installer's checksum and build provenance.
