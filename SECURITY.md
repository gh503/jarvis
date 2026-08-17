# Security Policy

## Supported Version

Only the latest commit on `main` is currently supported. Jarvis is pre-release software intended for personal evaluation on macOS 13 or later with Node.js 24 and the exact Harness versions in `package-lock.json`.

## Reporting a Vulnerability

Do not disclose vulnerabilities, credentials, personal data, or exploit details in a public Issue. Use GitHub's private vulnerability reporting for this repository.

Include the affected version, impact, reproduction steps, and a minimal proof of concept. Remove API keys, session transcripts, reminder content, audit records, and device identifiers from reports.

## Deployment Boundary

The Harness Web server must remain bound to `127.0.0.1` and must never be exposed through a public reverse proxy or shared interface. The separate Gateway defaults to loopback and may bind only to an explicit RFC 1918, Tailscale CGNAT, or IPv6 ULA address when TLS is configured. It rejects public, wildcard, named, and plaintext private-network bindings.

Remote Gateway access requires a paired device identity and short-lived access session. Owner operations use a separate local token. Browser clients call only the normalized Gateway API and never receive Harness internals, credential digests, or owner credentials. These controls reduce exposure but do not make Jarvis suitable for public internet deployment or multiple mutually untrusted users.

## Automated Gates

Pull requests and `main` run production dependency auditing, full-history secret scanning, code and contract tests, loopback listener verification, and an isolated backup/recovery rehearsal. A passing scan does not prove that no secret or vulnerability exists; rotate any credential that may have been exposed and report the incident privately.
