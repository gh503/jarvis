# Security Policy

## Supported Version

Only the latest commit on `main` is currently supported. Jarvis is pre-release software intended for local evaluation.

## Reporting a Vulnerability

Do not disclose vulnerabilities, credentials, personal data, or exploit details in a public Issue. Use GitHub's private vulnerability reporting for this repository.

Include the affected version, impact, reproduction steps, and a minimal proof of concept. Remove API keys, session transcripts, reminder content, audit records, and device identifiers from reports.

## Deployment Boundary

The current MVP must remain bound to `127.0.0.1`. It has no application authentication, TLS termination, remote device identity, or public ingress protection. Do not expose the Harness Web server through port forwarding, a public reverse proxy, or a shared network interface.
