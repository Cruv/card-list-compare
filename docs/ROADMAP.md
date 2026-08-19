# Roadmap

The committed backlog — the only roadmap. Open work at the top; shipped items are kept
briefly for rationale, not as a queue. (Replaces the untracked `CLAUDE.local.md` roadmap,
which was nowhere on a fresh clone.) Private/sensitive plans may still live in
`CLAUDE.local.md`; the default belongs here.

## Open — from the 2026-08-18 audit (`docs/audit-2026-08-18.md`, kept local)

Most criticals/highs shipped in v2.40.3–v2.41.2 + the infra/security batches. Remaining:

**Infra**
- Entrypoint signal handling: nginx is PID 1 and doesn't forward signals to node, so
  `docker stop` SIGKILLs the backend and the SIGTERM DB-flush never fires. Add a tini/init
  (or exec-forwarding entrypoint) so shutdown is graceful. Also fixes the zombie-container
  case (backend dies, nginx keeps PID 1 alive, restart policy never triggers).
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

**UI polish**
- Overlay stacking: one Escape press closes stacked overlays (MpcOverlay inside
  TimelineOverlay share the keydown); give overlays a shared focus trap + body-scroll lock.
- Auth-gated hash routes flash the compare UI / "Access Denied" before auth resolves.
- Delete the dead components (ComparisonOverlay, DeckTracker, TrackedDeckCard, NameModal —
  ~1,100 lines) and update the INVARIANTS doc that cites them.

**Housekeeping**
- Clear the ~40 pre-existing ESLint errors, then flip CI lint from advisory to blocking (D6).
- Consider lightweight release tags (`vX.Y.Z`) so GHCR publishes pinnable semver images (D4).

## Direction

- Keep the app uniform with the sibling app **WarSlate** in engineering approach (docs
  structure, ship discipline, verified commits) — see the convention docs added 2026-08.
- Future: TapTogether/playgroup features were scaffolded then removed; revisit only with a
  concrete plan.

## Recently shipped (rationale kept briefly)

- v2.41.x — Collection wired into deck views; TTS crash + multi-printing prices; notifications
  made real (price-alert baseline, verified-email gating + warning, rate limit, scheduler).
- v2.40.3–.5 — security criticals (JWT secret, atomic DB writes), data-loss fixes, core
  pipeline correctness (DFC/accents/CSV/differ). Plus infra (CSP, nginx) and token hashing.
