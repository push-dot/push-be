# TASKS spec format (Paseo writes design only; Cursor cloud agents write all code)
Write ONLY your output file under /Volumes/Untitled/scratch/tasks/. Do NOT edit/commit/push code in any repo. Read code with `git show origin/<branch>:<path>` or the existing worktrees, read-only.
Sources: push-fe branch design/handoff-2026-11-05 → docs/design-handoff/ (STATUS.md with "Who does what", gaps/g1–g4, gaps/_native-api.md, push-app/ design export); open PR branches listed in STATUS.md; push-be develop.

Each task (one PR-sized unit) uses exactly this shape:
## <ID> <title>
- Kind: design (Cursor, simple: copy/tokens/layout/markup) | logic (state/API/navigation/native wiring/BE)
- Branch: base branch to start from (existing PR branch or develop) + suggested new branch name
- Depends on: task IDs / PRs
- Files: exact paths to create/modify
- Design: artboard names (page › artboard) the result must match
- Logic design: types/interfaces (TypeScript or Python signatures), state shape, API contract (method, path, request, response, errors), navigation/route names, edge cases — enough that an implementer makes no product decisions
- Tests: test file + test names + key assertions
- Done when: verifiable checklist (commands that must pass, visible behaviour)
Keep each task concise. IDs: FE-A-xx main tabs, FE-B-xx 마이, FE-C-xx agent chat, FE-W-xx fo-web, FE-D-xx design system, FE-X-xx cross-cutting, BE-xx backend. Order tasks by dependency.
