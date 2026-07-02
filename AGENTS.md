# Agent Rules

These rules apply to automated and human-assisted code changes in this
repository.

1. Use durable, enterprise-grade solutions only. Fix the root cause, not the
   visible symptom.
2. Do not add temporary hacks, hidden TODOs, duplicated logic, or parallel
   sources of truth.
3. Do not delete logs unless the user explicitly asks for log deletion.
4. Preserve SSOT boundaries. Product vision lives in `PRODUCT.md`; release
   environment variables live in `.env.example`; app version lives in
   `desktop/package.json`.
5. Before edits, check `git status` and `git worktree list`, then keep changes
   atomic and commit only verified code.
