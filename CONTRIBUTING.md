# Contributing

Thanks for improving LCARS for Herdr. Keep changes focused, observable, and reversible.

## Local setup

Requirements: Node 22 or newer, Herdr 0.9 or newer, and `shellcheck` for launcher validation.

```sh
npm run check
npm run check:shell
npm test
node bin/lcars-bridge.mjs --port 4700
```

Use `http://127.0.0.1:4700/msd.html?demo=200` for visual work that should not depend on a live fleet.
Never commit local account catalogs, credentials, terminal output, context records, or bridge logs.

## Architecture boundaries

- `server/context/domain/` stays pure and does not import Node filesystem, child-process, or Herdr
  modules.
- Use cases depend on ports; concrete adapters are wired only in `composition.mjs`.
- One behavior has one implementation. Share frontend product logic through `public/shared.js` and
  translations through `public/i18n.js`.
- Keep all external input bounded and validated at its trust boundary. Escape untrusted data before
  it reaches HTML.
- State labels must remain semantically distinct: completed is green, waiting is orange, blocked is
  red, and working is amber.
- Any visible string must exist in both Spanish and English. Text never drops below 13 px.

## Pull requests

Describe the user job, the failure mode fixed, tests added, and visual evidence when the UI changes.
Run `npm run release:check` before requesting review. Do not weaken a security limit or platform
claim merely to make a test pass.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
