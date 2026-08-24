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

## Verification commands (run before every commit)

Backend (Python 3.12; a local interpreter without the deps is fine to skip —
CI runs these on every push):

```bash
python3 -m unittest discover -s backend/tests
```

Frontend:

```bash
npm --prefix frontend run typecheck   # tsc --noEmit
npm --prefix frontend run lint        # eslint .
npm --prefix frontend test            # vitest
npm --prefix frontend run build       # vite build (CI parity)
```

Desktop:

```bash
npm --prefix desktop test             # node --test (accelerator, packaging, engine-deps)
node --check desktop/main.js && node --check desktop/preload.js
```

A change is committable only when the suites covering it pass. Push `main`
after committing — work left only on a local branch is considered lost.

