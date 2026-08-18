# Decisions

Build-time decisions, in chronological order, each tracing to the requirement or
architecture invariant it serves. See `_bmad-output/planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md`
for AD-* definitions and `_bmad-output/specs/spec-Fleet-Pulse/requirements.md` for FR-*/NFR-*.

## Story 1.1 — Repo scaffold and the shared constants module

- **Scaffold source.** Used `create-vite` (react-ts template) rather than hand-assembling
  `package.json`/`tsconfig`/`vite.config.ts`, since the architecture spine pins exact
  versions to "the live scaffold's" output (TypeScript ~6.0.2, Vite 8.2.1) rather than to
  hand-picked ones. Verified installed versions match the spine's Stack table exactly:
  React 19.2.8, Vite 8.2.1, Zustand 5.0.15, Vitest 4.1.10, Express
  5.2.1, `ws` 8.21.3, concurrently 10.0.5, `@testing-library/react` 16.3.2. TypeScript
  resolves to 6.0.3 in the lockfile, inside the spine's `~6.0.2` pin (corrected during
  code review — this entry previously overstated it as matching "exactly"). (AD-2, Stack)
- **`shared/constants.js` shape.** Two named exports, `CLIENT_THRESHOLDS` and
  `SERVER_PARAMS`, mirroring `constants.md`'s two tables exactly, values unchanged from
  the spec. Plain ESM object literals per AD-2; `package.json` already carries
  `"type": "module"` from the Vite scaffold. No other module holds a tunable literal.
- **`npm start` composition.** `concurrently` runs `node server.js` alongside `vite`
  (dev server), matching the spine's runtime view. `server.js` does not exist until
  story 1.2, so `npm run server` (and therefore `npm start`'s server leg) fails with
  `MODULE_NOT_FOUND` until then — verified as the only failure, the client leg starts
  cleanly. `npm run dev` is kept as a client-only escape hatch.
- **Vite proxy.** Added `/api` (HTTP) and `/ws` (WebSocket, `ws: true`) as two separate,
  exact-prefix proxy rules to `:3000` in `vite.config.ts`, per the spine's explicit
  warning against a catch-all `ws: true` rule (which would also intercept Vite's own HMR
  socket). Not yet exercised end-to-end — server.js lands in story 1.2.
- **Vitest environment.** Set `test.environment: 'node'` as the project default in
  `vite.config.ts` (no separate `vitest.config.ts` — Vitest 4 reads the `test` block from
  the Vite config directly). Per-file `// @vitest-environment jsdom` docblocks opt
  individual UI-visible test files into jsdom later, per the spine's env-split
  convention.
- **Smoke test.** Added `shared/constants.test.js` (5 cases: numeric-shape check plus
  four cross-field pairing sanity checks, e.g. overspeed threshold below the
  sensor-fault ceiling). Not one of the 16+ mandated FR-cited cases — those start with
  the telemetry pipeline (story 1.4) — this one exists so `npm test` has something to
  run and to prove the harness works before later stories add real coverage.
- **Environment note.** Local Node is v25.6.1; the spine targets Node 24 LTS.
  `jsdom@30.0.1` emitted an `EBADENGINE` warning against 25.x (wants
  `^22.22.2 || ^24.15.0 || >=26.0.0`) but installed and ran correctly (constants smoke
  tests pass under the `node` environment; jsdom itself is unused until a later story
  adds a UI test). Left as-is — switching the local Node install is outside this story's
  scope and the mismatch has had no observed effect.
- **Deferred to later stories, on purpose:** `server.js` (1.2), `src/contract/`,
  `src/transport/`, `src/pipeline/`, `src/store/`, `src/ui/`, `src/app/` (populated by
  the stories that need them, not stubbed empty here), and the real `README.md` /
  `PROMPTS.md` root-level traceability writeup (story 1.10, per the epic context's
  cross-story dependencies).
- **`src/App.tsx`, `src/App.css`, `src/index.css`, `src/assets/*` are untouched
  `create-vite` demo content** (counter button, framework logos) — same "deferred on
  purpose" status as the directories above. These get replaced once the UI shell lands
  (`src/ui/`, `src/app/`, starting story 1.5 onward), not before.

### Review pass (blind-hunter, context-free)

Ten-plus-finding review run against this story's full diff. Applied directly (all
trivial, all scoped to this story's own files):

- `index.html` `<title>` — was `scaffold-tmp`, now `FleetPulse`.
- `README.md` — was 100% `create-vite` boilerplate with zero orientation; replaced with
  a minimal FleetPulse stub (name, one-paragraph description, run/test instructions,
  doc pointers) that explicitly says the full CAP-10 write-up is story 1.10's job, not
  this one's. The template's own Oxlint/React-Compiler notes are kept below it.
- `package.json` — added `"engines": { "node": ">=24.15.0" }` (the spine pins Node 24
  LTS; nothing previously recorded that anywhere machine-readable) and switched the
  `server` script to `node --watch server.js` (Node 24+ native watch, so story 1.2
  onward gets server-side reload symmetry with Vite's client HMR).
- `.nvmrc` — added (`24.19.0`, the spine's verified patch), so the pinned runtime is
  discoverable by tooling, not just prose in this file.
- `.gitignore` — added `.env` / `.env.local`, ahead of the server's env-var port
  fallback (Config convention) so a local override can't land in a commit by accident.
- `tsconfig.app.json` — added `"allowJs": true` and `"shared"` to `include`; previously
  `shared/constants.js` — the module every side of the app is documented to import —
  sat outside the TS project graph entirely (no compiler coverage, no editor
  IntelliSense tied to a tsconfig).
- `shared/constants.js` — wrapped both exports in `Object.freeze(...)`. The module's own
  header already asserts "a tunable literal anywhere else is a defect"; freezing makes
  accidental runtime mutation of the single source of truth fail loudly instead of
  silently.

Not applied, with reasons:

- **Exact (non-caret) dependency versions** — rejected. `package-lock.json` already
  pins the exact resolved versions the spine verifies; caret ranges plus a committed
  lockfile is standard npm practice, and "fixed stack, no additions" (SPEC constraint)
  governs library choice, not semver range style.
- **`.oxlintrc.json` vitest-plugin rules** — rejected. The spine's own Consistency
  Conventions table is explicit: "the scaffold's oxlint config as-is; no added lint
  tooling." Adding rules here would directly contradict a binding convention.
- **A test asserting `shared/constants.js` key-parity against `constants.md`** —
  rejected as over-engineering for a scaffold-story smoke test; the 16+ mandated,
  FR-cited test cases (none of which are this story's) start in story 1.4.
- **`vite.config.ts`'s hardcoded `localhost:3000` proxy targets** — deferred, not
  patched: making the dev-proxy target follow a server-side `PORT` env var only makes
  sense once story 1.2 defines that env var. Logged in `deferred-work.md`.

Re-ran `npm test`, `npm run build`, `npm run lint` after all patches — all still green.

### `.gitignore` scope: what's tooling vs. what's evidence

Added `.claude/` (17 MB — BMad skill/agent definitions) and `_bmad/` (468 KB — the BMad
module framework itself: scripts, config, per-module skill sources) to `.gitignore`.
Neither is this project's own content — both are the AI-workflow tooling used to
produce the planning artifacts, not the artifacts themselves.

**`_bmad-output/` (324 KB) stays tracked.** It holds the actual PRD, architecture
spine, SPEC + companions, `stories.yaml`, and `sprint-status.yaml` — the spec-driven-
development trail CAP-10 and G5 explicitly want graded ("the graded artifact is the
whole repository, not just the running app"). `DECISIONS.md` already references these
paths directly (e.g. `_bmad-output/specs/spec-Fleet-Pulse/constants.md`); excluding the
directory would break every one of those references for a reviewer cloning the repo.

### Code review pass (four layers: blind-hunter, edge-case-hunter, verification-gap, acceptance-auditor)

Adversarial review against commit `ff88679`. 6 decision-needed findings, 20 patch
findings, 7 deferred, 6 dismissed as noise. Full findings recorded in the story file's
Review Findings section. All 6 decisions resolved and all 26 resulting patches applied
in this pass:

- **`constants.md` + `shared/constants.js`** — added the constants AD-8, AD-3, and
  `constants.md`'s own text required but the module lacked: `WS_KEEPALIVE_PING_MS`
  (15 s), `STALENESS_TICK_MS` (1 s), `RECONNECT_BACKOFF_MULTIPLIER` (2),
  `BREAKER_FAILURE_THRESHOLD` (3), `FLEET_503_RETRY_AFTER_S` (3 s). Spec updated first,
  then code, per AD-2. Also added `SERVER_PARAMS.SERVER_PORT` (3000) so the port is no
  longer a literal living outside the module (was flagged as an AD-2 violation inside
  this story's own diff — `vite.config.ts` now imports it instead of hardcoding `3000`
  twice). A units-convention header comment was added (`_MS`/`_KMH`/`_PCT`/`_CHANCE`/`_S`).
- **`shared/constants.test.js`** — rewritten from 5 to 16 cases: explicit expected-key-set
  assertions per group (catches a deleted or renamed constant, demonstrated to slip past
  the old shape test); `Object.isFrozen` assertions on both exports; positivity and
  0..1-range checks; the two cross-boundary pairings the "Pairing rule" exists to protect
  (`FUEL_SUSPECT_WINDOW_MS` > glitch max; staleness threshold = 5× telemetry tick); the
  two previously-unchecked MIN/MAX pairs; and a stuck-speed truck-id format + fleet-bounds
  check. Rejected in the original pass as "over-engineering for a scaffold smoke test" —
  reversed once the review demonstrated each gap concretely with a real passing-when-it-
  shouldn't test run.
- **`tsconfig.app.json` / `tsconfig.node.json`** — added `"strict": true` to both (verified:
  compiles clean at zero cost today); added `"checkJs": true` to both (the earlier
  "compiler coverage" claim for `shared/` was false without it — `allowJs` alone only
  admits `.js` files to the program, it doesn't check them); restored `"DOM.Iterable"` to
  `tsconfig.app.json`'s `lib` (present in the stock `create-vite` template, dropped by
  this story's tsconfig edit); added `"shared"` to `tsconfig.node.json`'s `include` (now
  needed because `vite.config.ts` imports `shared/constants.js`).
- **`vite.config.ts`** — imports `SERVER_PARAMS.SERVER_PORT` instead of hardcoding `3000`
  twice; added `changeOrigin: true` to the `/ws` rule (was asymmetric with `/api`, which
  had it already — an origin check added later would reject dev WS traffic); tightened
  `/api` to `/api/` since Vite proxy keys match by prefix, not path segment.
- **`package.json`** — narrowed `engines.node` to `^24.15.0` (was `>=24.15.0`, silently
  admitting 25.x/26.x; `jsdom@30` already rejects 25.x, and this machine runs 25.6.1, so
  expect an `EBADENGINE` warning on install until it's on 24.x); added
  `--kill-others-on-fail` to the `concurrently` `start` script (a crashing/hung leg no
  longer leaves the other running with a masked exit code); added `--max-warnings 0` to
  `npm run lint` (warnings were accumulating invisibly — `react/only-export-components`
  is configured as `warn`).
- **`.gitignore`** — `.env` + `.env.*` replaces `.env`/`.env.local` (now also covers
  `.env.production`/`.env.development`, which nothing previously matched); added
  `coverage`.
- **`README.md`** — fixed a duplicate top-level heading (`# FleetPulse` and
  `# React + TypeScript + Vite` both `H1`; the template section is now `H2`/`H3`); added
  `npm run lint` and `npm run build` to the Run It block (both are part of the green bar
  this story records, neither was documented).
- **`ARCHITECTURE-SPINE.md`** — the Structural Seed file tree named `docs/` at repo root;
  the project never adopted that directory, tracking `_bmad-output/` instead (see the
  `.gitignore` scope decision above). Updated the seed to say `_bmad-output/`, reconciling
  a disagreement between the architecture and the actual tree that had no recorded
  decision.
- **`PROMPTS.md`** (new, repo root) — CAP-10 requires it "maintained throughout, not
  reconstructed at the end"; it was previously deferred to story 1.10, which is exactly
  that failure mode. Created now, seeded with story 1.1's build entry and this review
  pass's entry.
- **`deferred-work.md`** — narrowed the stale proxy-port deferral: the literal itself is
  fixed now (`SERVER_PARAMS.SERVER_PORT`); only the env-var *override*, which needs
  `server.js` to exist, remains deferred to story 1.2.
- **Commit message — not amended.** The acceptance-auditor finding read only
  `ff88679`'s subject line and concluded no FR/NFR/AD was cited; the full message body
  already reads "...server emission parameter (AD-2)." Caught this while carrying out
  the amend and skipped it — a no-op amend would have been pointless, and `NFR-9`
  (extensibility registries) doesn't actually fit this commit's content, so it was
  dropped from consideration too rather than force-added.

Re-ran `npm test` (16/16), `npm run build`, `npm run lint` after every patch in this
pass — all green throughout.
