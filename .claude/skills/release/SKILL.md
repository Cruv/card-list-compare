---
name: release
description: Prepare and verify a cohesive CardListCompare product release when the owner asks to ship or release it. Route documentation-only commits through the lighter contribution checks; committing alone does not authorize publication or deployment.
---

# CardListCompare delivery

Apply [CONTRIBUTING.md — Delivery and publication](../../../CONTRIBUTING.md#delivery-and-publication)
and its verification/evidence sections. They are canonical; this skill adds no separate gate.
Use [AGENTS.md](../../../AGENTS.md) for project boundaries if it is not already loaded.

- Classify the whole outcome: docs/internal commit or user-visible product release.
- Preserve foreign edits; stage owned paths. Use existing concrete commit/push authorization.
- Finish final edits and establish the required risk/release evidence once. Reuse valid
  results; version/Guide edits do not invalidate unrelated tests.
- Keep local checks, CI, native packaging, publication and household activation distinct.
  Never claim pending CI/physical/publisher checks passed or infer permission for tags/deploys.

Use available equivalent tools across AI clients. Read the operations or native packaging
references only when that explicitly authorized release includes those actions.
