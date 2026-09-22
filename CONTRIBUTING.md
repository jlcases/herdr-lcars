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

## Releases

A merged PR is not a release. Add a short English and Spanish entry to `CHANGELOG.md` under
`Unreleased` for each user-visible change; do not bump the version for every PR. For an urgent
security fix, consider a separate patch release rather than waiting for a feature batch.

Prepare one focused release PR that moves the selected entries to a numbered changelog section and
updates `package.json`, `package-lock.json`, `herdr-plugin.toml`, and both README install commands.
`npm run check` rejects mismatched versions. Run `npm run release:check` locally and wait for Linux
and Windows CI plus CodeQL on the exact release commit. No product code or account data belongs in
the release PR.

Only after the release PR is merged, tag that exact `main` commit with a new immutable `vX.Y.Z`
tag and create a GitHub Release using the bilingual changelog section as its notes. Verify a clean
Herdr installation with `herdr plugin install jlcases/herdr-lcars --ref vX.Y.Z --yes`, then invoke
`ping` and `open`. Never move an existing release tag or treat a green merge as publication.
