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
