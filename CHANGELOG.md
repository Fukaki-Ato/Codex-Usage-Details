# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Estimate GPT-6.2 Astra and Sol usage using recorded Fast and Ultrafast tiers, with the Ultrafast rate selected by usage time.
- Add GPT-6.2 Astra and Sol to cost estimates and the dashboard preview.
- Include sessions beyond the former 64 MiB file and 512 MiB total limits; stream oversized JSONL records and retain only usage metadata to bound memory use.
- Replace the default Electron icon with an original stepped C mark, including small-size artwork and multi-resolution Windows icons.
- Redesign the dashboard to match the supplied references: near-black surfaces, a full-width purple quota bar, separate accent-bordered metric cards, and stacked Token and request charts for each model.
- Default to 24 hours; keep account and model controls in an expandable toolbar, show active filters, and adapt chart geometry without stretching axis text.
- Remove obsolete five-hour quotas from Pro plans and show missing quota windows explicitly.
- Add verified GPT-6 and historical Codex model prices; document short-context and 30-minute cache-write estimates.
- Correct reasoning-token totals, estimated costs, and dated model price matching.
- Preserve log directories on reauthentication and prevent shared-directory attribution, including directory aliases.
- Support legacy turn contexts and official cache-write fields; deduplicate cumulative usage notifications.
- Read logs in a worker using streams and per-file caches; surface incomplete scans and read errors.
- Expire usage caches after 60 seconds, coalesce requests, and display actual retrieval timestamps.
- Make OAuth cancellation abort in-flight exchanges and isolate consecutive login sessions.
- Keep the sortable model summary, fixed legends, keyboard navigation, responsive controls and accessible dialogs.
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
