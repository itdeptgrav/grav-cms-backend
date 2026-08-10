# AI Collaboration Guide

## Codex responsibilities

Codex is responsible for:

- Product planning.
- Requirements and specification writing.
- Architecture review.
- Breaking work into small, sequential implementation tasks.
- Reviewing Claude Code's implementation and Git diff.
- Maintaining the collaboration documents under `docs/`.
- Avoiding application-code edits unless the user explicitly requests them.

Treat `docs/product/` and `docs/decisions/` as durable sources of truth. Treat `docs/tasks/current-task.md` as the active implementation scope. Keep the active task aligned with the durable product and architecture documents, and surface conflicts rather than silently resolving them through application-code changes.
