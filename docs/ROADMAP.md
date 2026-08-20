# Roadmap

The committed backlog — the only roadmap. Open work at the top; shipped items are kept
briefly for rationale, not as a queue. (Replaces the untracked `CLAUDE.local.md` roadmap,
which was nowhere on a fresh clone.) Private/sensitive plans may still live in
`CLAUDE.local.md`; the default belongs here.

## Open — from the 2026-08-18 audit (`docs/audit-2026-08-18.md`, kept local)

Most criticals/highs shipped in v2.40.3–v2.41.2 + the infra/security batches. Remaining:

**Infra**
- `.dockerignore` doesn't exclude `server/node_modules` — local builds can overlay the dev
  machine's modules onto the clean install.

**Product / features**
- **Share links**: add owner-side revocation + optional expiry (error copy already implies
  expiry that doesn't exist). SECURITY.md notes they're currently public-until-then.
- **Collection**: extend into the Overlap tab (owned coverage per deck) now that the deck
  views consume it; consider a "what do I still need to buy" per-deck view.
- MTGGoldfish/TCGPlayer imports: routing is fixed, but verify end-to-end and then advertise
  them in the guide + homepage subtitle.
- Invite-code expiry is checked but can't be set in the UI.

**Parser**
- The blank-line implicit-sideboard heuristic still fires inside Commander decks
  (`splitSections` in `src/lib/parser.js`): a blank line mid-list turns the rest into a
  sideboard even when the deck has an explicit Commander header. A `foundExplicitCommander`
  flag used to be tracked for this and never applied — it was removed as dead code, so the
  fix needs to re-add the condition **with tests** covering Commander lists that contain
  blank lines and lists that genuinely have a sideboard.

**UI polish**
- Consider virtualizing the deck list for very large collections (not currently a
  measured problem).

**Housekeeping**
- Consider lightweight release tags (`vX.Y.Z`) so GHCR publishes pinnable semver images (D4).
  Needs the owner's go-ahead — it changes the "tags only on request" rule in CLAUDE.md.

## Direction

- Keep the app uniform with the sibling app **WarSlate** in engineering approach (docs
  structure, ship discipline, verified commits) — see the convention docs added 2026-08.
- Future: TapTogether/playgroup features were scaffolded then removed; revisit only with a
  concrete plan.

## Recently shipped (rationale kept briefly)

- v2.42.x — shared modal layer (Escape/focus-trap/scroll lock across stacked overlays),
  auth-gated routes wait for the auth check and offer a sign-in screen; then a self-review
  pass fixed 30 regressions the earlier batches had introduced (per-printing pricing,
  price-alert zero guard, zero-byte DB recovery, container signal forwarding, collection
  badge allocation). ESLint backlog cleared and CI lint made blocking (D6).

- v2.41.x — Collection wired into deck views; TTS crash + multi-printing prices; notifications
  made real (price-alert baseline, verified-email gating + warning, rate limit, scheduler).
- v2.40.3–.5 — security criticals (JWT secret, atomic DB writes), data-loss fixes, core
  pipeline correctness (DFC/accents/CSV/differ). Plus infra (CSP, nginx) and token hashing.
