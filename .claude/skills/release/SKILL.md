---
name: release
description: Execute the CardListCompare delivery protocol — run after completing any feature, fix, or change set the user wants shipped. Triggers on "release", "ship it", "deliver", "bump and push", "do the delivery protocol". Runs tests, bumps APP_VERSION + package.json, replaces WHATS_NEW, checks Guide impact, commits vX.Y.Z, pushes, watches CI.
---

# Release / Delivery Protocol

Follow ALL steps in order. Never skip the tests. Never push a release without a
version bump. If any step fails, stop and fix — do not improvise around it.

Internal-only changes (docs, CI config, refactors with zero user-visible effect)
do NOT get a version bump — plain descriptive commit and push, then stop after
step 7's push. Everything user-visible follows the full protocol.

## 1. Preflight

- `git status --short` — only the intended changes should be dirty. Unrelated
  dirty files: STOP and ask the user.
- `git log --oneline --grep="^v[0-9]" -1` — the most recent `vX.Y.Z:` commit's
  version should match `APP_VERSION` in `src/App.jsx` (~line 27). (Plain
  internal commits may sit between releases — that's why this greps rather than
  just looking at the last commit.) Mismatch means a previous release was
  botched — surface it before stacking another on top.

## 2. Verify

- `npm test` — MUST pass. The suite includes `src/lib/invariants.test.js`
  (regex parity, Dockerfile COPY closure, parser contract, version sync).
  Never bump on red; never delete an invariant test to get to green.
- `npm run lint` — advisory (pre-existing debt). Rule: the change must not ADD
  errors. When lint is fully clean, make it blocking in CI
  (remove `continue-on-error` in .github/workflows/docker-publish.yml) and
  delete this carve-out.

## 3. Determine the bump (from the diff, not vibes)

- **PATCH** — bug fix, perf, dependency bump, copy tweak.
- **MINOR** — new user-visible feature or new API endpoint.
- **MAJOR** — breaking change to stored data (schema without migration), share
  links, or export formats. Rare; confirm with the user first.

## 4. Edit versions (src/App.jsx + package.json)

- Set `const APP_VERSION = 'X.Y.Z';`
- **REPLACE** the entire `WHATS_NEW` array (never append). Rules:
  - 1–4 short strings describing THIS release only, most important first.
  - Written for players, not developers ("Faster deck library loading", not
    "React.memo on DeckLibrary").
  - The toast shows the first two entries.
- Sync package.json:
  `npm version X.Y.Z --no-git-tag-version --allow-same-version`
  (also updates package-lock.json; the invariants test enforces equality).

## 5. Guide check (src/components/GuidePage.jsx)

Sections: getting-started, deck-comparison, importing-decks, deck-library,
deck-analytics, proxy-printing, export-formats, recommendations, faq.

- If the release changes anything a user can see or do: update the matching
  section (or add one to `SECTIONS`).
- If genuinely no user-facing impact: note `Guide: no impact` in the commit
  body so reviewers can see the check happened.

## 6. Re-verify

`npm test` again if steps 4–5 edited anything.

## 7. Commit and push

- `git add -A`, then `git status --short` to confirm exactly the intended files.
- `git commit -m "vX.Y.Z: Short imperative summary" -m "Details / Guide: no impact"`
  — single-line `-m` flags only (Windows-safe across PowerShell and Git Bash).
- `git push`
- Do NOT push a `vX.Y.Z` git tag unless the user asks — tags additionally
  publish semver-tagged Docker images.

## 8. Watch the gate

- `gh run list --limit 1` — confirm the workflow started.
- The `test` job now gates `build-and-push`. If CI fails on something that
  passed locally, investigate immediately (CRLF, node version, npm ci vs
  install) — do not re-push blind, and never disable the gate to get a build out.
