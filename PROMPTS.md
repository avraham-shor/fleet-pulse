# PROMPTS.md — AI Usage Journal

Chronological journal of AI usage during the build (implementation) phase of this project. Each entry records: the goal, how AI was used, what the AI produced, and — most importantly — **what I decided, corrected, or rejected**. Maintained live during the work, not reconstructed afterwards. The PRD/architecture/SPEC run has its own journal at `_bmad-output/planning-artifacts/prds/prd-Fleet-Pulse-2026-08-18/PROMPTS.md`; this one starts where that one hands off, at story 1.1.

---

## Entry 1 — 2026-08-18 — Story 1.1: repo scaffold and the shared constants module

**Tool:** Claude Code (BMad build skill).

**Goal:** Stand up the toolchain (Vite react-ts + TypeScript, Vitest wired for `npm test`, `npm start` running server + client together) and author `shared/constants.js` — the one module holding every tunable, per AD-2.

**How the AI was used:**
- Scaffolded with `create-vite` (react-ts) rather than hand-assembling config, since the architecture spine pins versions to the live scaffold's output.
- Authored `shared/constants.js` mirroring `constants.md`'s two tables exactly, plus `shared/constants.test.js` as a first smoke suite.
- Ran a context-free blind-hunter review pass against the story's own diff and applied its trivial, in-scope findings directly (recorded in `DECISIONS.md`).

**What I decided, corrected, or rejected:**
- Rejected exact (non-caret) dependency pins — the committed lockfile already pins resolved versions; caret ranges plus a lockfile is standard practice.
- Rejected adding vitest-plugin oxlint rules — the spine's Consistency Conventions are explicit: the scaffold's oxlint config as-is, no added lint tooling.
- Rejected a key-parity test between `constants.md` and `constants.js` as over-engineering for a scaffold-story smoke test at the time — later reversed in the story's code-review pass (Entry 2) once the review demonstrated it was needed.
- Deferred the Vite dev-proxy's hardcoded `:3000` target rather than guessing a port env var ahead of story 1.2.

## Entry 2 — 2026-08-18 — Story 1.1: adversarial code review, four layers

**Tool:** Claude Code (BMad code-review skill), four parallel review layers (blind-hunter, edge-case-hunter, verification-gap, acceptance-auditor) against commit `ff88679`.

**Goal:** Catch what a same-session author misses — missing invariants, untested edge cases, unverified claims in `DECISIONS.md`, and drift from the spec/architecture.

**How the AI was used:**
- Each layer read the story's full diff independently and reported findings with no cross-layer coordination.
- The verification-gap layer empirically tested claims against the real toolchain (e.g., demonstrated that `--strict` and `--checkJs` both compile clean today, that `Object.freeze` and the constants' key set had zero test coverage, and that `node --watch server.js` hangs rather than fails).
- The acceptance-auditor layer diffed the code against `constants.md`, `SPEC.md`, and the architecture spine directly.

**What I decided, corrected, or rejected:**
- 6 decision-needed findings — I resolved 5 of 6 as real fixes: update `constants.md` before code for the missing AD-8/AD-3 constants (keepalive interval, breaker threshold, backoff multiplier, staleness tick, `Retry-After` value); pull the server port into `SERVER_PARAMS` now rather than waiting for story 1.2's env var; narrow `engines.node` to `^24.15.0`; create this file now instead of deferring it to story 1.10; and reconcile the architecture spine's Structural Seed (`docs/` → `_bmad-output/`) since the project never adopted a separate `docs/` directory. The 6th (amend the commit message to add an AD/NFR citation) turned out to be a false positive on inspection — the finding read only the commit's subject line; the message body already cites `AD-2` — so I left the commit alone rather than making a pointless amend.
- 20 patch findings — applied all of them: `strict` and `checkJs` turned on in every tsconfig; the constants smoke suite rewritten with an explicit key-parity list, freeze assertions, positivity/range checks, and the two spec-mandated cross-boundary pairings that were previously untested; `concurrently --kill-others-on-fail`; the Vite proxy's `/ws` rule given `changeOrigin`; `lib` restored to include `DOM.Iterable`; `npm run lint` given `--max-warnings 0`; `.gitignore` env/coverage gaps closed; README and `DECISIONS.md` accuracy fixes.
- 7 findings deferred (pre-existing, correctly sequenced to later stories) and 6 dismissed as noise (mostly the review's own diff-scoping artifacts, not real gaps) — both recorded in the story file and `deferred-work.md`.
