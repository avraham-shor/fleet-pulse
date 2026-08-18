---
title: 'Repo scaffold and the shared constants module'
type: 'chore'
created: '2026-08-18'
status: 'done'
route: 'one-shot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The repository has a finished PRD, architecture spine, and SPEC, but no
code yet — no toolchain, no test runner, and no single source of truth for the tunable
values both the self-built server and the client depend on together.

**Approach:** Stand up the Vite react-ts + TypeScript scaffold with Vitest wired in,
matching the architecture's exact stack pins; wire `npm start` (concurrently: server +
Vite dev, with `/api` and `/ws` proxied to `:3000`) and `npm test` (`vitest run`); and
author `shared/constants.js` as the one ESM module holding every client threshold and
server emission parameter, per `constants.md` (AD-2).

</frozen-after-approval>

## Code Map

- `package.json` -- scripts (`dev`, `server`, `start`, `build`, `lint`, `test`), `engines`, and every pinned dependency version
- `vite.config.ts` -- dev-server `/api` + `/ws` proxy to `:3000`, Vitest `environment: 'node'` default
- `tsconfig.app.json` -- TS project coverage, extended to include `shared/`
- `shared/constants.js` -- `CLIENT_THRESHOLDS` and `SERVER_PARAMS`, frozen, the only home for any tunable
- `shared/constants.test.js` -- smoke coverage for the constants module
- `DECISIONS.md` -- this story's build-time decisions and the review pass that followed
- `_bmad-output/implementation-artifacts/deferred-work.md` -- one item deferred out of this story

## Suggested Review Order

**Entry point**

- Scripts wire the whole story together: scaffold + server placeholder + constants, one command each.
  [`package.json:9`](../../../../package.json#L9)

**Shared constants module**

- The story's actual deliverable: every client-side threshold, frozen, mirroring `constants.md` exactly.
  [`constants.js:15`](../../../../shared/constants.js#L15)

- The other half of each pair: what the (not-yet-built) server emits, so each threshold has something real to classify.
  [`constants.js:61`](../../../../shared/constants.js#L61)

- Smoke coverage proving the module loads and its cross-field pairings (e.g. overspeed < sensor-fault ceiling) hold.
  [`constants.test.js:1`](../../../../shared/constants.test.js#L1)

**Dev tooling & build config**

- Two exact-prefix proxy rules, never a catch-all `ws: true` (would also swallow Vite's own HMR socket).
  [`vite.config.ts:9`](../../../../vite.config.ts#L9)

- Vitest reads its config from here directly (no separate `vitest.config.ts`); node is the default env, jsdom opts in per-file later.
  [`vite.config.ts:22`](../../../../vite.config.ts#L22)

- `shared/` brought into the TS project graph so `constants.js` gets compiler + editor coverage.
  [`tsconfig.app.json:9`](../../../../tsconfig.app.json#L9)

**Runtime pins & repo hygiene**

- Pins Node 24 LTS machine-readably, not just in prose.
  [`package.json:6`](../../../../package.json#L6)

- `.env` / `.env.local` excluded ahead of the server's planned port-fallback env var.
  [`.gitignore:16`](../../../../.gitignore#L16)

**Traceability**

- Build-decision log starts here, per CAP-10, including the full record of the blind-hunter review pass and what was patched vs. deferred vs. rejected.
  [`DECISIONS.md:1`](../../../../DECISIONS.md#L1)

- The one finding deferred out of this story (proxy target should track the server's future port env var).
  [`deferred-work.md:1`](../../../implementation-artifacts/deferred-work.md#L1)

## Review Findings

Adversarial code review, 2026-08-18 — four layers (blind-hunter, edge-case-hunter,
verification-gap, acceptance-auditor) against commit `ff88679`. 6 decision-needed,
20 patch, 7 deferred, 6 dismissed as noise. All 6 decision-needed findings were
resolved by Avraham on 2026-08-18 and are now tracked as patch items below — 26
patch findings total, 25 applied and 1 (D4) found to be a false positive on
inspection.

- [x] [Review][Patch] (resolved D1) Add the constants AD-8, AD-3, and `constants.md`'s own text require but the module lacks — keepalive interval, breaker failure threshold (3), backoff multiplier (2), staleness re-evaluation tick, server `Retry-After` value, and FR-19's client-side ghost-disconnect tolerance. Decision: update `constants.md` first (it is missing these rows too), then mirror into `shared/constants.js`, so spec and code move together per AD-2.
- [x] [Review][Patch] (resolved D2) Add `SERVER_PORT` to `SERVER_PARAMS` in `shared/constants.js` and import it in `vite.config.ts` in place of the two hardcoded `3000` literals [vite.config.ts:13,17]. Decision: the literal belongs in the module now; the env-var *override* can still land with story 1.2. Update `deferred-work.md` to remove the now-stale deferral entry (or narrow it to just the override).
- [x] [Review][Patch] (resolved D3) Narrow `engines.node` to `^24.15.0` [package.json:6-8], matching `.nvmrc` and the spine's Node 24 LTS pin. Expect an `EBADENGINE` warning on this machine (Node v25.6.1) until it switches to 24.x — that is the intended effect.
- [x] [Review][Patch] (resolved D4 — found to be a false positive, no change made) The underlying finding read only `ff88679`'s subject line; the message body already reads "...server emission parameter (AD-2)." `NFR-9` (extensibility registries) doesn't fit this commit's content either. Left the commit as-is rather than performing a pointless amend.
- [x] [Review][Patch] (resolved D5) Create root `PROMPTS.md` now, seeded with story 1.1's entry, so it is maintained continuously per CAP-10 rather than reconstructed at story 1.10.
- [x] [Review][Patch] (resolved D6) Update the architecture spine's Structural Seed to name `_bmad-output/` instead of `docs/` (or add a `docs/` pointer), and record the reconciliation in `DECISIONS.md`.

- [x] [Review][Patch] `strict` is absent from every tsconfig [tsconfig.app.json, tsconfig.node.json] — `tsc --showConfig` confirms no `strict` key anywhere; the whole ten-story build type-checks with `noImplicitAny`/`strictNullChecks` off. Verified: `tsc -p tsconfig.app.json --strict` exits 0 today, so this is free to turn on now and expensive later. Also makes the `!` in `src/main.tsx:6` meaningful.
- [x] [Review][Patch] `allowJs` without `checkJs` delivers no compiler coverage [tsconfig.app.json:9] — the story's Code Map and `DECISIONS.md` both claim `shared/` was added "so `constants.js` gets compiler + editor coverage". `allowJs` only admits the file to the program; `checkJs` is what reports errors in it. Demonstrated: a `.js` file with a real type error compiles at exit 0 under these exact options, and errors under `--checkJs`. Verified `--checkJs` exits 0 on the current tree.
- [x] [Review][Patch] `npm run server` hangs instead of failing, and `npm start` masks it [package.json:11-12] — `node --watch server.js` with no `server.js` prints `MODULE_NOT_FOUND` then holds at "Waiting for file changes before restarting..." indefinitely; it never exits, never returns non-zero. `DECISIONS.md`'s "verified as the only failure" was accurate for plain `node server.js` but is stale after the `--watch` switch. `concurrently` also lacks `--kill-others-on-fail`, so the client leg survives and the aggregate exit code hides it.
- [x] [Review][Patch] The smoke test cannot observe a deleted or renamed constant [shared/constants.test.js:5-13] — the shape test iterates `Object.entries` and asserts nothing about which keys must exist. Demonstrated: deleting `FLEET_SIZE` and `BANNER_CLEAR_HYSTERESIS_MS` leaves the suite at 5/5 green, and an emptied export object passes vacuously. `server.js` is `.js` and outside every tsconfig `include`, so it gets no compiler backstop either — it would read `undefined` silently. Fix: assert an explicit expected key list per group.
- [x] [Review][Patch] `Object.freeze` — a named story deliverable — has no assertion [shared/constants.js:15,61] — demonstrated: removing both `Object.freeze(` calls leaves the suite at 5/5 green, with `build` and `lint` equally blind. The freeze is also what makes TypeScript infer `Readonly<{...}>`, so its loss silently removes the compile-time guard for every future `.ts` consumer too.
- [x] [Review][Patch] The two pairings that cross the client/server boundary are the two left untested [shared/constants.test.js] — `FUEL_SUSPECT_WINDOW_MS` (5000) must exceed `FUEL_FALSE_ZERO_GLITCH_MAX_MS` (4000), or every simulated glitch becomes a false alert; `STALENESS_BADGE_THRESHOLD_MS` (10000) must stay 5 x `TELEMETRY_TICK_MS` (2000), which the comment claims but nothing enforces. The four existing assertions are three intra-group orderings plus one cross-group — the Pairing rule exists to protect exactly the boundary these two span.
- [x] [Review][Patch] Two of four MIN/MAX pairs are unchecked for inversion [shared/constants.test.js:25-33] — `FUEL_FALSE_ZERO_GLITCH_MIN_MS`/`MAX_MS` and `STUCK_SPEED_DURATION_MIN_MS`/`MAX_MS` have no ordering assertion; an inversion yields an empty random interval or `NaN` duration.
- [x] [Review][Patch] Probability constants are only checked for finiteness [shared/constants.test.js:5-13] — `GHOST_DISCONNECT_CHANCE` (0.2) and `FLEET_503_CHANCE` (0.15) would pass as `20` or `-1`, making injected faults always or never fire. Assert `0 <= x <= 1`.
- [x] [Review][Patch] No positivity assertion on duration/count constants [shared/constants.test.js:5-13] — every `*_MS`, `*_CAP`, `*_COUNT` passes `Number.isFinite` at `0` or negative. `TELEMETRY_TICK_MS: 0` would ship as valid and turn `setInterval` into a busy loop.
- [x] [Review][Patch] `STUCK_SPEED_TRUCK_ID` is skipped entirely by the shape test [shared/constants.test.js:6] — it is `continue`d past with no assertion that it is a non-empty string, and its index (`truck_7`) is never checked against `FLEET_SIZE` (12). A truck id outside the fleet means that fault scenario silently never fires.
- [x] [Review][Patch] Batch budget vs. coalesce window has no invariant [shared/constants.js:39,49] — `BATCH_PROCESSING_BUDGET_MS` (50) must stay under `1000 / RENDER_COALESCE_MAX_COMMITS_PER_SEC` (100 ms). Holds today; nothing pins it. Overrun means the coalescing backlog grows unbounded (NFR-1, NFR-2).
- [x] [Review][Patch] `/ws` proxy omits `changeOrigin` while `/api` sets it [vite.config.ts:16-19] — the WS upgrade reaches `:3000` carrying the Vite dev origin. Any origin validation added in story 1.2 rejects dev traffic, and the asymmetry between the two rules is unexplained.
- [x] [Review][Patch] `/api` prefix also matches `/apidocs` and similar [vite.config.ts:12] — Vite proxy keys match by prefix, not path segment, so the "exact prefixes only" comment overstates what the rule does. All real routes are `/api/...`; use `/api/`.
- [x] [Review][Patch] `lib` drops `DOM.Iterable` [tsconfig.app.json:5] — the `create-vite` react-ts template ships `["ES2023", "DOM", "DOM.Iterable"]`; this is `["ES2023", "DOM"]`. Makes `for...of` over `NodeList`/`HTMLCollection`/`FormData` a compile error once the real UI lands in story 1.5+.
- [x] [Review][Patch] `npm run lint` cannot fail on warnings [package.json:14] — bare `oxlint` with `react/only-export-components` configured as `"warn"` means warnings accumulate invisibly across ten stories. `--max-warnings 0` fixes it; note this is the script's threshold, not an added lint rule, so it does not touch the spine's "scaffold's oxlint config as-is" convention.
- [x] [Review][Patch] `.gitignore` env coverage is uneven [.gitignore:16-17] — `.env.local` is already covered by `*.local` (line 19) while `.env.production` and `.env.development` match nothing. `coverage/` is also missing despite a `test` script and 16+ mandated cases coming.
- [x] [Review][Patch] Test file naming and titles miss the traceability conventions [shared/constants.test.js] — the spine says "colocated `*.test.ts`" and `requirements.md:3` says test names reference FR/NFR ids. `.js` is defensible here (AD-2 mandates plain ESM JS) but the deviation is undeclared; of five titles only one cites an id (`CM1`).
- [x] [Review][Patch] `DECISIONS.md` version claim is imprecise — "Verified installed versions match the spine's Stack table exactly ... TypeScript ~6.0.2" lists a range, not a version; the lockfile resolves `typescript` to **6.0.3**. Everything else checks out exactly (React 19.2.8, Vite 8.2.1, Zustand 5.0.15, Vitest 4.1.10, Express 5.2.1, ws 8.21.3, concurrently 10.0.5).
- [x] [Review][Patch] `README.md` has two H1 headings and omits `lint`/`build` — `# FleetPulse` and `# React + TypeScript + Vite` are both top-level (MD025); the template block should drop to `##`. The "Run it" section documents only `install`/`start`/`test`, though `DECISIONS.md` treats `lint` and `build` as part of the green bar.
- [x] [Review][Patch] No stated unit convention in the constants module [shared/constants.js] — `FUEL_ALREADY_LOW_PCT: 10` is percentage-points while `GHOST_DISCONNECT_CHANCE: 0.2` and `FLEET_503_CHANCE: 0.15` are fractions. Both faithful to `constants.md`, but the first consumer to write `Math.random() < FUEL_ALREADY_LOW_PCT` is caught by nothing. One header line fixes it.

- [x] [Review][Defer] No tsconfig will ever cover `server.js`, and nothing keeps `shared/` DOM-free [tsconfig.node.json:22] — deferred, lands with story 1.2
- [x] [Review][Defer] `npm start` does not run at HEAD while the story is closed — deferred, correctly sequenced against story 1.2 and honestly disclosed in `DECISIONS.md`
- [x] [Review][Defer] `create-vite` demo content ships as the application [src/App.tsx, src/App.css, src/index.css] — deferred, explicitly scheduled for story 1.5
- [x] [Review][Defer] No CI workflow runs `lint`/`build`/`test` on push — deferred, no story currently owns it
- [x] [Review][Defer] No coverage tooling (`@vitest/coverage-v8`, `test:coverage`, `coverage` config) — deferred, first real coverage lands story 1.4
- [x] [Review][Defer] No `.env.example` despite gitignoring `.env` — deferred, the env var name is story 1.2's to define
- [x] [Review][Defer] No Prettier / `.editorconfig` / `.gitattributes`; CRLF churn unguarded on Windows — deferred, spine forbids added lint tooling

**Dismissed as noise (6):** assets "missing from the diff" (`favicon.svg`, `icons.svg`, `hero.png`, `react.svg`, `vite.svg` are all in `git ls-tree ff88679` — they were excluded by the review's own diff scoping); SSE/WS terminology "inconsistency" (SSE rides `GET /api/telemetry/stream` through the existing `/api` rule — no rule is missing); `target="_blank"` without `rel="noopener"` (implied by all modern browsers since 2021, and the code is scheduled for deletion); no proxy `error` handler (Vite logs proxy errors already); `shared/constants.test.js` pulled into `tsc -b` (compiles clean, and excluding it would cost editor coverage); root-absolute `/icons.svg` under a non-root `base` (app is local-only, `base` is never changed).
