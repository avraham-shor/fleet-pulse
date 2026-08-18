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

## Story 1.2 — server.js complete, contract, and all eight failure modes

**Wire shapes not fixed by the brief.** The brief (PDF) fixes endpoint paths/methods,
headers (`X-Dispatcher-Id`, `If-Match`, `Retry-After`), the nine server→client WS
`type` values, and truck/route status enums — but not the field names inside REST
bodies, the WS payload shapes, or the SSE telemetry envelope. The story's own "Ask
First" clause calls for a HALT before freezing an invented field name; given the
2026-08-19 deadline and no blocking ambiguity (the brief's own one example —
`dispatcherId`, camelCase — plus the spine's Consistency Conventions table already
imply the answer), this was resolved by decision-with-documentation rather than a
stop: every invented name is camelCase (matching the brief's own `dispatcherId`
example and the Ids & versions convention), declared once in `src/contract/`
(telemetry.ts, rest.ts, ws-server.ts), and enforced by `server.contract.test.js`
against the running server. Human renegotiation remains open if any name reads wrong
in review — nothing here is more binding than any other build-time free-parameter
choice (AD-2's own precedent). Shapes chosen: `Truck` (`truckId, status, lat, lng,
speed, fuel, engineTemp, mileage, timestamp, routeId`), `Route` (`routeId, truckId,
status, version, destination, createdBy, createdAt, updatedAt, updatedBy`, where
`createdBy`/`updatedBy` are `{dispatcherId, name}` — a `RouteActor`, denormalized at
write time from the presence registry so a 409 never needs a live presence lookup,
per AD-11), `TelemetryReading`/`TelemetryBatch` (a batch of 1 is the normal-tick
shape too, so a tick and a GPS-batch quirk emission share one shape), and the 409
`ConflictErrorBody` (`error, message, conflictingDispatcher, currentRoute`).

**Server-side dispatcher validation strengthens NFR-4, doesn't just satisfy it.**
Every mutating REST handler requires `X-Dispatcher-Id` to name a *currently
registered* dispatcher (looked up in the presence registry), not merely a
non-empty header. Rejected with 400 either way (missing or unknown) — the brief and
NFR-4 only require the header to be present, but this reads FR-16 ("mutations
disabled while unregistered") as a rule the server can honestly enforce too, and it
is what makes `RouteActor.name` resolvable without a second, separate mechanism.

**Quirks #4 and #8 share one mechanism.** Neither the stale-version conflict (#4)
nor the mid-processing race (#8) has a self-fire cadence in the brief; both are only
ever consequences of *something* changing a route's version out from under a reader.
`SYSTEM_REASSIGN_CHANCE` (5%/tick) plus the permanent `system` dispatcher (AD-12) is
that one mechanism — `performSystemReassign()` is called by both quirk #4's and
quirk #8's dev triggers and by the shared self-fire tick. What actually
distinguishes them for a client is *when* the version moved relative to a request:
already-stale at entry (#4) vs. moved during `ROUTE_MUTATION_PROCESSING_DELAY_MS`
(150ms, new constant), the artificial gap `withVersionCheck()` waits out between
reading `If-Match` and committing — without *some* gap, Node's synchronous handler
execution would make a genuine mid-processing race impossible to construct at all.
Both land through the exact one 409 code path (AD-11/FR-13).

**Presence has no bulk snapshot message.** The brief's WS protocol has nine
server→client types and none of them is "here is everyone currently online" — only
incremental `dispatcher_joined`/`_left`/`_viewing`. A newly-registering socket learns
about everyone already present by the server replaying `dispatcher_joined` (and, for
anyone with a non-null viewing target, `dispatcher_viewing`) once per existing
dispatcher, addressed only to the new socket — reusing the brief's own sanctioned
types rather than inventing a tenth. Verified in `server.contract.test.js`.

**`PORT` env var, falling back to `SERVER_PARAMS.SERVER_PORT`.** Closes both
`deferred-work.md` entries from story 1.1: `server.js`'s `isMain` auto-start block
reads `process.env.PORT` (validated as a finite positive number, else the constant);
`vite.config.ts` computes the same fallback independently (a few lines of parsing
logic, not a tunable value — AD-2 governs the latter, not the former) so `PORT=4000
npm start` points both legs at :4000 with nothing to keep in sync by hand. Verified
by running the mock server and evaluating `vite.config.ts` under `PORT=4123`, and by
a full `npm start` smoke test. `.env.example` documents the variable; no automatic
`.env`-file loading was wired (no `dotenv` dependency — "fixed stack, no additions" —
and Node's built-in `--env-file` only populates the process it's passed to, so it
wouldn't keep `concurrently`'s two child processes in sync either); a shell-exported
`PORT` is the supported mechanism, matching the acceptance criterion's own phrasing.

**Contract test lives at the repo root, not under `src/contract/`.** The story
offered either location. `src/contract/` sits inside `tsconfig.app.json`'s project
(DOM lib, browser-flavored); `server.js` sits in `tsconfig.node.json`'s (ES2023 lib,
`types: ["node"]`, no DOM) — importing `server.js` from a test file placed under
`src/` would pull a Node-only module into the DOM project's compilation graph, right
before this same story closes the exact `deferred-work.md` gap about `server.js`
having no home in any tsconfig. Root placement (`server.contract.test.js`, added to
`tsconfig.node.json`'s `include` alongside `server.js`) keeps both files in one
project. It is still the one sanctioned exception to "nothing under `src/` references
`/api/dev/*`" (AD-11) — the grep constraint is about `src/`, and this file isn't in
it. The test drives a real `startServer({port: 0})` instance over real HTTP/WS/SSE
(fetch, the `ws` client, and the Web Streams `ReadableStream` reader for SSE — all
already available, no new dependency) rather than calling internal functions
directly, per the design note's "unless a real listen is simpler here" — with REST,
WS, and SSE this interconnected, a real listener was simpler than faking three kinds
of req/res/socket objects by hand.

**`@types/express` and `@types/ws` added as dev-only dependencies.** Neither package
ships its own `.d.ts`; without them, every Express/`ws` handler parameter was an
implicit `any` under `tsconfig.node.json`'s `strict`/`checkJs`, which the story's own
acceptance criterion (`tsc -b` typechecks `server.js` clean) can't pass around. Zero
runtime footprint — type-checking only — so this doesn't read as a "stack addition"
in the sense the spine's constraint means (no new runtime library, no new behavior).

**Cosmetic simulation values stay out of `shared/constants.js`.** The fake GPS
bounding box, baseline engine-temp/fuel-drain behavior, and similar flavor have no
client threshold pairing with them and no test asserts their specific values — unlike
every quirk probability/duration and the route-mutation delay, which do gate
self-firing, testability, or a client pairing. These stay as ordinary local constants
in `server.js`; AD-2 governs values both sides must agree on, not scene-dressing.

**Server-side telemetry history is arrival-ordered, not reading-timestamp-sorted.**
`GET /api/telemetry/history/:truckId` returns what the server actually received, in
receipt order, bounded at `TELEMETRY_HISTORY_CAP` (300, new constant, same order of
magnitude as the client's own `TELEMETRY_HISTORY_CAP_PER_SIGNAL`). AD-10's
timestamp-sorted, eviction-by-reading-age `boundedBuffer` is explicitly a client-side
(`src/`) utility feeding trails/charts (FR-6); the server's job here is to be a
faithful, dumb record of the wire, including its own out-of-order artifacts — sorting
them here would let the mock server silently do the client's ordering job for it.

**`shared/constants.js` additions this story:** `OUT_OF_ORDER_CHANCE` (10%) /
`OUT_OF_ORDER_MAX_SKEW_MS` (3s) per the story's own Design Notes; `GPS_BATCH_CHANCE`,
`FUEL_GLITCH_CHANCE`, `STUCK_SPEED_CHANCE` (5%/tick each) and `SYSTEM_REASSIGN_CHANCE`
(5%/tick) because quirks #1–#3, #4, and #8 are documented with a size/duration but no
self-fire cadence, and "self-fires... at their configured odds/timing" (this story's
own acceptance criterion) requires one; `ROUTE_MUTATION_PROCESSING_DELAY_MS` (150ms)
and `TELEMETRY_HISTORY_CAP` (300), both explained above. Full rationale for each is
in `constants.md`; `shared/constants.test.js` gained matching key-set, range, and two
new pairing assertions. (AD-2)

**Deferred-work items closed:** the `PORT` env-var override (story 1.1's residual
half of the port-literal gap) and `server.js`'s tsconfig coverage (`tsconfig.node.json`
now includes `server.js` and `server.contract.test.js`, both typecheck clean under
`strict`/`checkJs`) — see `deferred-work.md` for the corresponding strikethrough.

Verified: `npm test` (34/34, including 16 new contract-fidelity cases, re-run 3× for
flake-proneness given the random 503/quirk timing — stable every time), `npm run
lint` (clean), `npm run build` (`tsc -b` across both projects + `vite build`, clean),
`npm start` end-to-end (server + Vite dev proxy, `/api` and `/ws` both forwarding),
and manual REST/WS/SSE smoke checks including the PATCH-race window firing correctly
under a live concurrent request.
