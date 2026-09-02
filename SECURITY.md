# Security Policy

## Reporting a Vulnerability

Please do not report security vulnerabilities in a public GitHub issue.

Open a private security report through the repository's GitHub Security tab when
available. If private reports are not enabled, contact the repository owner
through GitHub before sharing sensitive details.

Include the affected version, operating system, reproduction steps, impact, and
any logs with credentials removed.

## Credential Handling

- Never include API keys, OAuth tokens, account files, or private Codex session
  logs in an issue or pull request.
- Redact credentials before attaching screenshots or diagnostic output.
- The application stores credentials through Electron `safeStorage`; users
  should still use a separate least-privileged key where possible.
- The account store is located under Electron's user data directory. It contains
  encrypted credentials, but account names, email addresses, plan metadata,
  remote account identifiers, and selected local log paths are not themselves
  encrypted.
- The local session scan has file count, file size, total size, and directory
  depth limits to avoid unbounded memory use when a broad directory is chosen.
