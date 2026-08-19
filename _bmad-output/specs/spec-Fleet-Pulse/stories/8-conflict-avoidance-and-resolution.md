---
title: 'Conflict avoidance and resolution'
type: 'feature'
created: '2026-08-19'
status: 'done'
review_loop_iteration: 0
baseline_commit: '58c496f35d29f80f30ed4491c0ceca5469050747'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/specs/spec-Fleet-Pulse/requirements.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 1.7 built the mutation gate and left every 409 as a plain "reload and retry" error with no recovery path, and nothing warns a dispatcher before they submit into a change someone else already made — the brief's flagged senior-level design challenge is still unbuilt.

**Approach:** Build CAP-5 (FR-13, FR-31): one shared inline `ConflictChooser` fed directly by the 409 body — adopt / re-apply / back out — reused identically by transition, cancel, and reassign (all three already collapse to the same 409 shape server-side); plus FR-31's non-blocking inline avoidance notice that compares a row's armed-at version against the live WS-echoed version, firing before a save is attempted.

## Boundaries & Constraints

**Always:**
- The chooser triggers strictly on `TransportFailure.kind === 'conflict'` from a route mutation (transition, cancel, reassign) — `createRoute` has no `If-Match` and cannot conflict server-side; its error path is untouched.
- One shared, presentational `ConflictChooser` component, driven only by the failure's own `body.conflictingDispatcher`/`body.currentRoute` (never from store state) — display is correct regardless of WS-echo arrival timing (FR-13: "attribution guaranteed by the 409 body").
- Re-apply resubmits the exact same intended mutation (the same target status or reassign truckId already captured in the row's armed state) with `If-Match` set to `currentRoute.version` from the failure body.
- Adopt and back out are both: clear the row's armed/failure state, send no request. Routes have no mergeable fields (`destination` is immutable post-create; `status`/`truckId` are the only mutable ones), so there is no partial-accept scenario — offer both as distinctly labeled affordances for dispatcher clarity, not as two different code paths.
- FR-31's avoidance notice: capture the route's `version` at the moment a row's action is armed; on every render, if the live `route.version` (from the store) has since moved, show a non-blocking inline notice naming the other dispatcher and that the version moved — the confirm control stays enabled; ignoring the notice and submitting anyway is allowed and lands in the chooser above if it does conflict.
- No modal library, no npm dependency — inline JSX, matching `RoutesPanel.tsx`'s existing two-stage arm/confirm visual language.

**Ask First:** None anticipated.

**Never:** Touch `server.js`, `src/contract/rest.ts`, or `src/transport/api-client.ts` — all three already fully support this end to end. Touch `FleetOverview.tsx` or `PresencePanel.tsx`. Build any merge or partial-accept UI. Add a version check to `createRoute` or otherwise make create conflict-capable.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Conflict on transition/cancel | 409 during a status transition | `ConflictChooser` renders inline, naming the conflicting dispatcher and both versions | FR-13 |
| Conflict on reassign | 409 during reassign | Same `ConflictChooser` component renders — proves the one shared path | FR-13 |
| Adopt | dispatcher clicks Adopt | Armed/failure state clears; no request sent | FR-13 |
| Re-apply | dispatcher clicks Re-apply | Resubmits the same intended mutation with `If-Match: currentRoute.version` | FR-13 |
| Back out | dispatcher clicks Back out | Armed/failure state clears; no request sent | FR-13 |
| FR-31 notice fires | row armed, then the live `route.version` moves before submit | Non-blocking inline notice appears naming who and that the version moved; submit stays enabled | FR-31 |
| No notice when unarmed | `route.version` moves while the row has no armed action | No notice — nothing pending to warn about | N/A |
| Create never conflicts | any `createRoute` call | `describeFailure`'s create path is unchanged; the chooser never renders for create | N/A |

</frozen-after-approval>

## Code Map

- `src/contract/rest.ts:42-46,50-60,86-90` (`RouteActor`, `Route`, `ConflictErrorBody`) -- already declared, no contract changes. `destination` (`:55`) confirmed immutable post-create (no update endpoint anywhere in `api-client.ts`).
- `server.js:230-237` (`sendConflict`), `:566-585` (`withVersionCheck`, the ~150ms `ROUTE_MUTATION_PROCESSING_DELAY_MS` race window at `:574`) -- reference only, no server changes; confirms both trigger paths (stale-version, mid-processing race) already collapse to one 409 shape before the client ever sees it.
- `src/transport/api-client.ts:24-27` (`TransportFailure`'s `conflict` variant), `:139-147` (`isConflictErrorBodyShape`), `:297-300` (`mutate<T>`'s 409 branch) -- already built and fully unused beyond plain-error text; call directly, no changes.
- `src/ui/widgets/routes/RoutesPanel.tsx:61-70` (`describeFailure`, `case 'conflict'` today: a plain string, no chooser) -- replace this branch's *route-mutation* call sites (not create's) with `ConflictChooser` rendering; conflict call sites at `:228` (transition/cancel) and `:247` (reassign).
- `src/ui/widgets/routes/RoutesPanel.tsx:198-202` (`RouteRow`'s local state: `reassignTarget`, `reassignArmed`, `cancelArmed`, `inFlight`) -- extend with a captured `armedAtVersion` (set whenever `cancelArmed`/`reassignArmed`/a transition is armed) for FR-31's live-vs-armed version comparison, and a `conflict: ConflictErrorBody | null` field to drive the chooser.
- `src/ui/widgets/routes/RoutesPanel.tsx:84,105-110` (`CreateRouteForm`'s `confirmArmed` two-stage pattern) -- template for the chooser's own arm/confirm-style rendering; create itself is out of scope (cannot conflict).
- `src/ui/widgets/routes/ConflictChooser.tsx` (new) -- presentational component: props `{conflictingDispatcher, currentRoute, myIntentLabel, onAdopt, onReapply, onBackOut}`; inline, no modal, mirrors `RouteRow`'s existing confirm-affordance styling.
- `src/ui/TrustBadge.tsx` -- pattern to mirror for a small, stateless, prop-driven display component (co-located under `routes/` here since it is single-consumer, unlike `TrustBadge`).
- `src/ui/widgets/routes/RoutesPanel.test.tsx:291-312` -- currently asserts the *absence* of a chooser ("story 8's concern"); update to assert its presence and behavior instead.

## Tasks & Acceptance

**Execution:**
- [x] `src/ui/widgets/routes/ConflictChooser.tsx` (new) -- presentational chooser: conflicting dispatcher name, both versions, Adopt/Re-apply/Back-out controls -- FR-13
- [x] `src/ui/widgets/routes/RoutesPanel.tsx` -- `RouteRow`: on a transition/cancel/reassign `conflict` failure, render `ConflictChooser` instead of the plain error text; wire Adopt/Back-out to clear state with no request, Re-apply to resubmit with `If-Match: currentRoute.version` -- FR-13
- [x] `src/ui/widgets/routes/RoutesPanel.tsx` -- `RouteRow`: capture `armedAtVersion` when an action arms; render FR-31's non-blocking inline notice when the live `route.version` has since moved, without disabling submit -- FR-31
- [x] `src/ui/widgets/routes/RoutesPanel.test.tsx` -- update the existing "no chooser" test (`:291-312`) to assert the chooser now renders and behaves correctly
- [x] Co-located `*.test.ts`/`.test.tsx` covering the full I/O matrix: chooser-on-transition, chooser-on-reassign (proving the shared path), adopt, re-apply, back-out, FR-31 notice appears while armed, no notice while unarmed, create never conflicts

**Acceptance Criteria:**
- Given a transition and a reassign each independently conflict, when their 409s land, then both render through the exact same `ConflictChooser` component (FR-13's "reached identically by both paths," verified client-side as one shared code path).
- Given a row is armed and the live route version moves, when FR-31's notice appears, then the submit control remains enabled and the dispatcher can still proceed (non-blocking).
- Given `npm test`, when it runs, then the full suite passes with no regressions.
- Given `npm run lint` and `npm run build`, when run, then both are clean (`--max-warnings 0`; `tsc -b` + Vite build).

## Spec Change Log

## Design Notes

Adopt and back-out are mechanically identical (clear state, no request) because routes have no mergeable fields — `status`/`truckId` are exclusive, one-value-wins mutations, and `destination` never changes after creation. Offer them as two clearly labeled buttons anyway (e.g. "Use their version" vs. "Never mind") for dispatcher clarity, not as two implementations to build separately.

The story description's "stale-version and mid-processing race paths" are already indistinguishable to the client — `server.js`'s `withVersionCheck` collapses both into one `sendConflict` call before either ever reaches `api-client.ts`. Nothing here needs to special-case them; one `conflict` failure branch already covers both by construction.

## Verification

**Commands:**
- `npm test` -- expected: full suite green including new conflict-chooser and FR-31 tests
- `npm run lint` -- expected: clean, `--max-warnings 0`
- `npm run build` -- expected: `tsc -b` + Vite build clean

**Manual checks (if no CLI):**
- `npm start` + `npm run dev`, two tabs: arm a transition on the same route in both tabs, submit in tab A first, then tab B — tab B should show the FR-31 notice before submitting (if timed right) and the `ConflictChooser` after submitting into the 409; try Adopt, Re-apply, and Back out each in turn.

## Suggested Review Order

**Conflict resolution flow (FR-13)**

- The 409 body plus a resubmission closure — the one shared shape both mutation paths populate.
  [`RoutesPanel.tsx:204`](../../../../src/ui/widgets/routes/RoutesPanel.tsx#L204)

- Transition/cancel populates `conflict` on a 409, carrying its own re-issuable mutation.
  [`RoutesPanel.tsx:282`](../../../../src/ui/widgets/routes/RoutesPanel.tsx#L282)

- Reassign populates the exact same `conflict` shape — proves the one shared path FR-13 asks for.
  [`RoutesPanel.tsx:311`](../../../../src/ui/widgets/routes/RoutesPanel.tsx#L311)

- Re-apply resubmits with `If-Match` from the 409 body itself; a repeat conflict re-arms the chooser.
  [`RoutesPanel.tsx:321`](../../../../src/ui/widgets/routes/RoutesPanel.tsx#L321)

- Adopt/Back-out share one no-request reset, including the reassign-target clear (patch, iteration 1).
  [`RoutesPanel.tsx:254`](../../../../src/ui/widgets/routes/RoutesPanel.tsx#L254)

- Conflict state takes over the row's controls entirely, ahead of the normal arm/confirm UI.
  [`RoutesPanel.tsx:364`](../../../../src/ui/widgets/routes/RoutesPanel.tsx#L364)

**Shared ConflictChooser component**

- Presentational only, driven solely by the failure's own body — never store state (attribution timing-proof).
  [`ConflictChooser.tsx:42`](../../../../src/ui/widgets/routes/ConflictChooser.tsx#L42)

- Adopt/Re-apply/Back-out share one button style, since two of the three are mechanically identical.
  [`ConflictChooser.tsx:59`](../../../../src/ui/widgets/routes/ConflictChooser.tsx#L59)

**FR-31 avoidance notice**

- Armed-at-version captured per action (cancel vs. reassign), so arming one can't clobber the other's baseline.
  [`RoutesPanel.tsx:222`](../../../../src/ui/widgets/routes/RoutesPanel.tsx#L222)

- Notice requires both a version drift and that action's own control still being on screen.
  [`RoutesPanel.tsx:379`](../../../../src/ui/widgets/routes/RoutesPanel.tsx#L379)

**Styling**

- `.notice` reuses the `--warning` token already shared with FR-34's analogous banner.
  [`RoutesPanel.module.css:94`](../../../../src/ui/widgets/routes/RoutesPanel.module.css#L94)

**Tests**

- Shared-path, Adopt/Re-apply/Back-out, and repeat-conflict coverage for transition/cancel and reassign alike.
  [`RoutesPanel.test.tsx:323`](../../../../src/ui/widgets/routes/RoutesPanel.test.tsx#L323)

- FR-31 notice coverage: fires while armed (both actions), silent while unarmed.
  [`RoutesPanel.test.tsx:506`](../../../../src/ui/widgets/routes/RoutesPanel.test.tsx#L506)

- Proves `createRoute`'s error path is untouched — the chooser never appears for create.
  [`RoutesPanel.test.tsx:599`](../../../../src/ui/widgets/routes/RoutesPanel.test.tsx#L599)

- Isolated rendering and callback-contract coverage for the chooser itself.
  [`ConflictChooser.test.tsx:37`](../../../../src/ui/widgets/routes/ConflictChooser.test.tsx#L37)
