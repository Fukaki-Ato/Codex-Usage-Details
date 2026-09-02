# Contributing

## Development

Use Node.js 20 or newer:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Run the desktop development app with:

```bash
npm run dev
```

## Pull Requests

- Keep changes focused and explain the user-visible effect.
- Add or update tests for parsing, normalization, storage, or other behavior
  changes.
- Do not include API keys, OAuth tokens, private logs, or generated `dist/`
  files.
- Check that `npm test`, `npm run typecheck`, and `npm run build` pass before
  opening a pull request.
