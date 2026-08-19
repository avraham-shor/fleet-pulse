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

## Entry 3 — 2026-08-18 — Story 1.3: wire contract types and the transport layer

**Tool:** Claude Code, working directly from the frozen story spec (`_bmad-output/specs/spec-Fleet-Pulse/stories/3-wire-contract-types-and-the-transport-layer.md`) rather than through the BMad build skill's own loop this time — implemented, tested, and documented in one pass per the story's Tasks & Acceptance checklist.

**Goal:** Declare the client→server half of AD-13's wire contract (`ws-client.ts`, `rest.ts` request bodies) and build the two connection owners (`sse-manager`, `ws-manager`) plus the one mutation gate + circuit breaker (`api-client`) — the transport boundary every later store/UI story builds on.

**How the AI was used:**
- Read the story file, its full `context:` frontmatter (architecture spine, requirements, constants), and the relevant `server.js` line ranges (WS parsing, REST handlers, header/error-code handling) before writing anything, per the story's own Code Map.
- Designed the handler-injection seam (`onMessage`/`onConnect`/`onBatch`/`getDispatcherId`) the story's Design Notes call for, and the `WebSocketLike`/`EventSourceLike` structural interfaces that make both connection managers testable without a live socket.
- Wrote all three transport modules plus co-located `*.test.ts` files (fake sockets/EventSource, injected clocks — no real timers or network in any test), then iterated on `tsc -b` and `vitest run` until both were clean.
- Ran a manual proxy-level smoke test (`npm start`, curl through Vite's dev proxy, force-killed and let the server self-restart) since `app/` doesn't exist yet to host a real browser client — verified in `DECISIONS.md`.

**What I decided, corrected, or rejected:**
- Hit a real TypeScript gotcha: `shared/constants.js`'s `Object.freeze`d exports infer literal property types (`1000`, not `number`), so `let currentBackoffMs = CLIENT_THRESHOLDS.RECONNECT_BACKOFF_INITIAL_MS` failed to typecheck once the backoff-doubling logic tried to reassign it. Fixed with an explicit `: number` annotation at each read site rather than touching the shared module (the freeze is intentional, AD-2).
- Decided `registered`/`pong` are consumed by `ws-manager` internally rather than forwarded through the generic `onMessage` handler — AD-17 treats the client's own identity as session state, not a presence event, and `pong` is pure keepalive plumbing, not a domain event a store slice should ever see.
- Rejected letting a non-503 failure count toward the circuit breaker's 3-strike threshold or auto-retry — FR-25's own wording is specifically "three consecutive... 503s"; a network error or a 500 is normalized to the `error` union kind and returned immediately instead.
- Added two `error`-kind failure codes the brief never named (`not_registered`, `network_error`/`invalid_response`) to keep every possible failure — including a local refusal and a thrown `fetch` — inside AD-7's three-kind discriminated union, rather than inventing a fourth union member or letting anything throw past `api-client`.
- Used a `satisfies Record<ServerWsMessage['type'], true>` object instead of a bare `Set` literal for ws-manager's "known message type" check, so forgetting to update it when a tenth WS message type is ever added to the contract is a compile error, not a silent runtime drop.

## Entry 4 — 2026-08-18 — Story 1.3: code review — self-run, single pass

**Tool:** Claude Code, adversarial self-review of the story's own diff before reporting completion (no separate subagent layer this time, given the story's moderate size and the existing test-driven verification already in place).

**Goal:** Catch design or edge-case gaps in the transport layer before calling the story done — particularly around the circuit breaker's exact state transitions and the reconnect backoff's edge behavior, both flagged by the spec as mandated test coverage.

**How the AI was used:** Re-read `AD-7`/`AD-8`/`AD-17` and the story's I/O & Edge-Case Matrix line by line against the finished `api-client.ts`/`ws-manager.ts`/`sse-manager.ts`, specifically checking: does every failure path actually reach the 3-kind union with no throw; does the breaker's probe-vs-closed-loop distinction match FR-24/FR-25's wording exactly; does `sendViewing` behave safely when called before the socket opens; does a stale/superseded socket's late callback ever corrupt state after a reconnect race.

**What I decided, corrected, or rejected:**
- Added the `mySocket`/`mySource` local-capture guard (`if (socket !== mySocket) return`) in both connection managers' `onopen`/`onmessage`/`onclose`/`onerror` handlers after noticing a superseded socket's late-arriving event could otherwise clobber state set by a newer connection — not something the story's own acceptance criteria named directly, but a direct consequence of "manual reconnect" (close + recreate) that the design notes call for.
- Confirmed (via a dedicated test using a `.json()` that throws if called) that the breaker's `Retry-After` handling never touches the response body, matching the story's explicit "never parsed from JSON" constraint literally, not just in spirit.

## Entry 5 — 2026-08-18 — Story 1.3: coordinator-relayed 3-layer code review (blind-hunter, edge-case-hunter, verification-gap)

**Tool:** Claude Code, applying 8 `patch`-classified findings from an external 3-layer adversarial review run against the story's diff (relayed by the coordinator, not run by me this pass).

**Goal:** Fix the 8 real, in-scope, trivially-fixable gaps the review found — a breaker streak-reset bug, a `Retry-After` null-header bug, an untrusted 409-body cast, a missing `forceNextProbe()` seam for the future `fleet_reset` sequence, missing RTT/reconnect-count/dropped-count observability getters, a stale-backoff-on-reconnect bug, and zero test coverage for the stale-callback guards Entry 4 added — then re-verify the full spec Verification section.

**How the AI was used:** Applied each of the 8 fixes directly in the flagged files, then wrote a regression test for every one (not just the mandated #9) to match the codebase's own established rigor rather than fixing silently. For the stale-callback-guard finding specifically, reproduced the reviewer's own verification method: temporarily stripped the `socket !== mySocket`/`source !== mySource` guards from both managers, confirmed exactly the new guard test failed in each (and nothing else), then restored the files byte-for-byte (`diff`-confirmed) before the final clean run — proving the new tests actually catch the regression they're meant to guard, not just asserting happy-path behavior that would pass either way.

**What I decided, corrected, or rejected:**
- Placed the `connect()` backoff reset *after* the existing idempotency guard (`if (socket !== null || reconnectTimer !== null) return`) rather than literally at the top of the function as the finding's wording suggested. Reasoned through it first: resetting before the guard would also fire on a call that's already a no-op (already connected, or a reconnect already pending), silently corrupting an in-progress backoff escalation the pending reconnect hasn't used yet. Placement after the guard fixes the exact reported bug (`close()` clears both guard conditions, so a fresh `connect()` always reaches the reset) without that side effect — functionally equivalent for the bug in question, safer for the guarded case. Documented the reasoning in `DECISIONS.md` in case a reviewer wanted the literal placement.
- Added a `now` injection option to `ws-manager` for RTT measurement (defaulting to `Date.now`) rather than relying on vitest's fake-timer `Date` mocking, matching `api-client`'s existing explicit-clock-injection pattern instead of introducing a second, implicit way of controlling time in tests.
- Went beyond the coordinator's explicit ask (new tests were only mandated for finding #9) and added regression tests for all 8 fixes — each new behavior or bug fix without a test would have been exactly the kind of gap the review was already flagging elsewhere in the same pass.

## Entry 6 — 2026-08-19 — Story 1.10: observability and submission traceability (final story)

**Tool:** Claude Code, working directly from the frozen story spec (`_bmad-output/specs/spec-Fleet-Pulse/stories/10-observability-and-submission-traceability.md`), after reading its full `context:` frontmatter (architecture spine, requirements catalog, constants, test matrix) plus the actual line ranges the story's Code Map named in `sse-manager.ts`, `ws-manager.ts`, `api-client.ts`, `bootstrap.ts`, `obsSlice.ts`, `pipeline/types.ts`, `registry.ts`, and `App.tsx` before writing anything.

**Goal:** Close out CAP-10 — the two remaining observability widgets (FR-29 dispatcher anomaly view, FR-30 developer metrics panel), the one net-new metric they needed (SSE events/sec), and the final traceability write-up (README's data-flow walkthrough and NFR-9 tire-pressure example, the closing DECISIONS.md/PROMPTS.md entries, the FR-29/FR-30 test-matrix rows) — with no placeholder text left anywhere in the submission.

**How the AI was used:**
- Read every existing widget (`PresencePanel.tsx`, `RoutesPanel.tsx`, `VehicleDetail.tsx`) before writing the two new ones, specifically to match their established selector/memoization conventions rather than inventing a fifth pattern.
- Implemented `AnomalyView` and `DevMetrics` as pure read-only registry widgets, the SSE events/sec rolling-window counter in `sse-manager.ts`, the `TransportCounters.sseEventsPerSecond` field, and the one new line in `bootstrap.ts`'s existing staleness tick wiring it all together — then wrote co-located tests for every changed/new file before moving on, per the codebase's own established "tests alongside, not deferred" convention.
- Ran the full `npm test`/`npm run lint`/`npm run build` cycle after the code changes, before starting the documentation pass, to catch regressions early rather than discovering them while writing prose about a system that no longer matched it.
- Wrote README's data-flow walkthrough, decisions/trade-offs section, multi-dispatcher conflict-handling section, known-issues section, and the NFR-9 tire-pressure worked example by re-reading the actual current implementation (not the architecture spine's description of intended behavior) — e.g. `ConflictChooser.tsx`'s real button labels ("Use their version" / "Re-apply" / "Never mind") to keep the conflict-handling section's prose accurate to what a dispatcher actually sees, not a paraphrase of the FR text.

**What I decided, corrected, or rejected:**
- Caught a real bug while writing `AnomalyView`'s own rerender test, before it could ship: selecting `state.obs.anomalyLog` directly would never re-render on a new anomaly in production, because `pushAnomaliesPure` mutates the `BoundedBuffer` in place and only replaces the *outer* `obs` object — the buffer's own reference never changes across a push, so Zustand's snapshot comparison would never see a change on that narrower selector. Fixed by selecting `state.obs` instead (which *is* replaced on every non-empty push), matching `RoutesPanel.tsx`'s own `routesState` selector convention. Recorded in `DECISIONS.md` as its own entry since it's a genuine correctness finding, not just an implementation note.
- Decided SSE events/sec counts every frame the connection delivers, not just successfully-parsed ones — it's a transport-activity rate, not a parse-success rate (the existing, separate dropped-message counter already covers parse failures). Recorded the reasoning in a code comment and a dedicated test asserting a malformed frame still counts.
- Read the story's Boundaries mention of `api-client.getBreakerState()` as documentation of which existing tick the new wiring piggybacks on, not as a fifth metric `DevMetrics` must display — FR-30's own text and the story's frozen I/O & Edge-Case Matrix both name exactly four metrics, neither mentions circuit/breaker state. Chose the narrower, more literal reading over growing `TransportCounters` with a field no acceptance criterion asked for; documented the reasoning in `DECISIONS.md` in case a reviewer expected the broader one.
- Rejected adding a rationale row to `constants.md` for the new `SSE_EVENTS_PER_SEC_WINDOW_MS` tunable, following the precedent already set by `ANOMALY_LOG_CAP`/`AUDIT_TRAIL_CAP`/`TRUCK_ALERT_CAP` (all added to `shared/constants.js` with an inline comment, never backfilled into `constants.md`'s tables) — the story's own Code Map names only `shared/constants.js` for this addition, and `constants.md` is a context/reference file this story reads, not one its Code Map lists as editable.
- Fixed one incidental README staleness bug while replacing the placeholder block: the "Run it" section still said `npm start`'s server leg "has nothing to run until server.js lands" — true only through story 1.1, false since story 1.2. Left unfixed, it would have undercut the very traceability pass this story exists to close out.

## Entry 7 — 2026-08-19 — Story 1.10: coordinator-relayed code review, 3 patch-category findings

**Tool:** Claude Code, applying 3 `patch`-classified findings from a code review run against this story's diff and relayed by the coordinator (not run by me this pass).

**Goal:** Fix the 3 real, in-scope, trivially-fixable gaps the review found — a `data-testid`/`key` disambiguation mismatch in `AnomalyView`, a stale-state leak across `close()`→`connect()` in `sse-manager.ts`'s new events/sec counter, and an undocumented cold-start under-report in the same getter — then re-run the story's own `## Verification` commands and confirm all three stay clean.

**How the AI was used:** Applied each of the 3 fixes directly in the flagged files, wrote or extended a regression test for each of the two behavioral fixes (the third was doc-only by design — the review explicitly asked for a comment, not an algorithm change), then re-ran `npm test`/`npm run lint`/`npm run build` in full before reporting back.

**What I decided, corrected, or rejected:**
- For the `data-testid` fix, threaded `index` into `AnomalyRow` as an explicit prop rather than recomputing it a different way inside the component — keeps `key` and `data-testid` deriving from the exact same three values (`truckId`, `readingTs`, `index`) at the exact same call site, so they can't drift apart again the way this finding showed they already had.
- For the `close()` fix, reset only `eventTimestamps` — left `droppedMessageCount`/`reconnectCount` untouched, since those are documented as intentionally cumulative across reconnects (FR-30 obs, story 1.3's own design) and the finding was specifically about a *rate*, not a lifetime counter, having no meaningful "current" value across a deliberate teardown.
- Accepted the third finding's framing without pushback: the fixed-window-average approach is what the story's own Design Notes specify, so the fix is documentation (a JSDoc comment plus a README bullet), not a request to swap in an elapsed-time-based algorithm the story never asked for.

## Entry 8 — 2026-08-19 — Story 1.6 follow-up: dispatcher presence liveness heartbeat

**Tool:** Claude Code, ad hoc fix outside the formal per-story build loop — epic-1's 10 stories were already built, reviewed, and committed by this point; this closes a `deferred-work.md` item from story 1.6's original code review that was explicitly flagged `NEEDS A HUMAN DECISION` rather than fixed mechanically at the time.

**Goal:** Close the gap where a dispatcher who registers and then never touches the viewing selector again silently vanishes from every peer's presence list after `PRESENCE_LIVENESS_TIMEOUT_MS` (30s) — undercutting story 1.6's own stated purpose ("see who else is active"). Three options had been logged: (a) accept as-is, (b) raise the timeout, (c) add a lightweight heartbeat.

**How the AI was used:**
- I walked through the three options with the AI first — asked it to explain the mechanism precisely (which two events refresh `lastSeenAt`, why the sweep evicts a silent-but-connected dispatcher, why the root cause sits inside the story's own frozen spec content) and lay out the real tradeoffs of each option before I picked one, rather than have it just implement something.
- I picked (c) and asked for a time estimate before committing to it. The AI investigated the actual wire protocol first and found the client already sends an unconditional `ping` every `WS_KEEPALIVE_PING_MS` (15s, `ws-manager.ts`) and the server already tracks each dispatcher's live `viewingTruckId` in its `presence` map (`server.js`) — so a full heartbeat could piggyback on existing plumbing instead of a new message type.
- I chose the pragmatic short track over the project's full by-the-book ceremony (spec reopening, 3-layer review round) given the submission deadline. The AI implemented it: `server.js`'s `ping` handler now also re-broadcasts the pinging dispatcher's current `dispatcher_viewing` (unchanged `truckId`) to peers; doc comments updated in `ws-client.ts`/`ws-server.ts`; the existing ping-pong scenario in `server.contract.test.js` extended with a queue-length-delta assertion (the re-broadcast's content is identical to a prior real change, so only a count delta proves the new broadcast fired); `deferred-work.md`'s flagged item closed out with a dated annotation, matching the project's own established close-out convention.
- The AI ran the full verification cycle itself before reporting back: `npm test` (346/346), `npm run lint` (clean), `npm run build` (`tsc -b && vite build`, clean) — catching and fixing one real type error along the way (`waitUntil`'s check callback is typed `() => Promise<boolean>`; the first draft returned a plain `boolean`).

**What I decided, corrected, or rejected:**
- Chose option (c) over (a)/(b) specifically because it's the only one that actually closes the gap rather than accepting or merely delaying it — and because the AI's investigation showed the real fix was cheap once the existing ping/pong plumbing was accounted for, changing the cost-benefit relative to my first-pass instinct that (b) (raise the timeout) might be the safer deadline-day choice.
- Deliberately skipped this project's usual full ceremony (spec-file reopening, 3-layer adversarial review, a fresh `spec_checkpoint`) for this one change — a conscious scope call given the deadline, not an oversight. Noted explicitly so a later reviewer doesn't mistake the lighter trail for carelessness.
- Confirmed for myself that the fix doesn't actually touch the frozen refresh-trigger rule at all (still only `dispatcherJoined`/`dispatcher_viewing` refresh `lastSeenAt` on the client) — only how often the server *sends* the latter changed. That's what made the short track defensible here rather than a shortcut around the frozen-spec discipline.
- Left `sprint-status.yaml`, `PROMPTS.md`'s per-story spec-checkpoint fields, and the two unrelated pre-existing uncommitted files (`App.tsx` import order, `RoutesPanel.module.css`'s `.auditList` class) untouched — out of scope for this fix specifically.
