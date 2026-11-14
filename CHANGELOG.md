# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Correct reasoning-token totals, estimated costs, and dated model price matching.
- Preserve log directories on reauthentication and prevent shared-directory attribution, including directory aliases.
- Support legacy turn contexts and official cache-write fields; deduplicate cumulative usage notifications.
- Read logs in a worker using streams and per-file caches; surface incomplete scans and read errors.
- Expire usage caches after 60 seconds, coalesce requests, and display actual retrieval timestamps.
- Make OAuth cancellation abort in-flight exchanges and isolate consecutive login sessions.
- Replace long model cards with a sortable summary and selected-model charts; add fixed legends, keyboard navigation, responsive controls and accessible dialogs.
- Use built assets for `npm start`; require explicit `--dev` for the development server.
- Update dependencies and the development/CI baseline to Node.js 22.12 or newer.

## [0.1.3] - 2026-09-04

- Include OpenAI o-series, Codex, ChatGPT, and fine-tuned model identifiers.
- Ignore model identifiers from other providers when reading API and local usage.

## [0.1.2] - 2026-09-02

- Use the clear ICO asset for the Windows application and desktop shortcut icon.

## [0.1.1] - 2026-09-02

- Recreate the desktop shortcut when the application is reinstalled or updated.

## [0.1.0] - 2026-09-02

- Initial public release preparation.
- Added API usage and ChatGPT subscription usage views.
- Added local Codex session log aggregation.
- Added account management, OAuth login, encrypted credential storage, and
  Windows packaging configuration.
