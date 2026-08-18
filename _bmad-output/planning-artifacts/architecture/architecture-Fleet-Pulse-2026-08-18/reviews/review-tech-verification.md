# Review — Tech Verification Lens

**Spine:** `ARCHITECTURE-SPINE.md` (Fleet-Pulse, 2026-08-18)
**Lens mandate:** verify every committed decision was web-researched / reality-checked rather than asserted from training data — current versions, technologies still exist and fit, live starter defaults (greenfield).
**Reviewed:** 2026-08-18, against live npm registry, vite.dev, expressjs.com, vitest.dev, nodejs release data, and vitejs GitHub issues.

## Verdict

**PASS WITH CORRECTIONS.** The Stack table's claim "verified current on npm 2026-08-18" holds up: all ten version pins match npm `latest` today, Node 24.19.0 is the real current Active-LTS release, and every claimed technology exists and fits the design. Two scaffold-fact errors/gaps (TypeScript row wording; test deps not in the starter) and one known dev-proxy behavior risk (SSE client-abort propagation) need correction or a build-time check. Nothing invalidates an AD.

## Findings

### Critical

None.

### High

- **H-1 — TypeScript row implies the scaffold pins 7.0.2; the live scaffold pins `~6.0.2`.** The current `create-vite` react-ts template (`create-vite@9.1.2`, template on vitejs/vite main) pins `"typescript": "~6.0.2"`. npm `latest` for `typescript` *is* 7.0.2 (verified), but TS 7 is the native-compiler line and is **not** what the scaffold installs; a builder reading "per Vite scaffold (npm latest 7.0.2)" could reasonably pin 7.0.2 and diverge from the scaffold the spine tells them to keep. **Fix:** reword the row to `TypeScript ~6.0.2 (scaffold pin — keep; npm latest is 7.0.2, do not hand-upgrade)`.

### Medium

- **M-1 — The starter does not scaffold Vitest or Testing Library; the spine's test stack is a manual add and should say so.** Live react-ts template devDependencies: `@types/node ^24.13.3`, `@types/react ^19.2.18`, `@types/react-dom ^19.2.4`, `@vitejs/plugin-react ^6.0.5`, `oxlint ^1.78.0`, `typescript ~6.0.2`, `vite ^8.2.1` — no vitest, no jsdom, no @testing-library/*. **Fix:** annotate the Stack table (or Structural Seed) that Vitest 4, jsdom, `@testing-library/react` + its `@testing-library/dom ^10` peer are installed on top of the scaffold.
- **M-2 — SSE client-abort propagation through the Vite dev proxy has a documented upstream-bug history; unverified in Vite 8.** vitejs/vite #12157 / #13522 ("dev server doesn't receive SSE close event" through the proxy) were closed **not planned** as upstream (node-http-proxy) bugs. Vite now extends the maintained `http-proxy-3`, but close-forwarding through it was not re-verified anywhere the spine cites. Impact: in dev, `server.js` may never observe `EventSource` closes, leaking entries in its SSE client set. Server→client drops (the ghost-disconnect quirk) are unaffected. **Fix:** have `server.js` reap SSE clients on write error (it writes every 2 s, so dead sockets surface fast) and smoke-test browser-side disconnect through the proxy in the first transport story.
- **M-3 — Vitest 4 removed `workspace` in favor of `projects`; the spine's two-environment test split must use the current mechanism.** The spine runs most tests in node env and UI tests under jsdom. In Vitest 4 that's either `test.projects` in `vitest.config.ts` or per-file `// @vitest-environment jsdom` docblocks — a stale `vitest.workspace.js` pattern from training-data vintage will error. **Fix:** one line in the Tests convention naming per-file env annotations (or `projects`) as the split mechanism.

### Low

- **L-1 — Scope the WS proxy rule to `/ws` exactly; never proxy `^/` with `ws: true`.** Vite's own HMR runs over a WebSocket on the dev-server origin; a catch-all ws proxy is the one known way to break it. The spine's `/api` + `/ws` rules are safe as written. **Fix:** none needed — note for the build story writing `vite.config.ts`.
- **L-2 — Express 5: `req.body` is `undefined` without `express.json()`.** Express 5.2.1 verified; its breaking changes (named wildcards, removed `res.send(status)`, path syntax) don't touch the spine's routes, which use plain named params only. The one trap for `server.js` is that mutation routes need `app.use(express.json())` mounted or every POST/PATCH/PUT body is `undefined`. **Fix:** one word in AD-12's import list ("express + json body parsing").
- **L-3 — Scaffold lints with `oxlint`, not ESLint, and `build` runs `tsc -b && vite build`.** No spine conflict (spine never mentions lint), recorded so nobody "restores" an ESLint setup that was never there.

## Verified (with sources)

All checks performed live on 2026-08-18:

- **Vite 8.2.1 = npm latest**; engines `^20.19.0 || >=22.12.0` — satisfied by Node 24. — https://registry.npmjs.org/vite/latest
- **Vite 8 migration guide (v7→v8):** Rolldown/Oxc replace Rollup/esbuild; browser-target bumps; CJS-interop consistency. **No change to `server.proxy` shape**; dev proxying still extends `http-proxy-3`. — https://vite.dev/guide/migration
- **`server.proxy` config shape + `ws: true`** proxies WebSocket upgrades to a separate backend port (docs example: 5173→5174); `rewriteWsOrigin` caveat noted; underlying lib `http-proxy-3`. Same-origin `/api` + `/ws` seed is supported as written. — https://vite.dev/config/server-options
- **SSE through the Vite proxy streams** when the backend sets `text/event-stream` and no compression middleware sits in the path (`server.js` uses none); historic buffering reports trace to backend compression or nginx-style buffering, not Vite defaults. Client-abort forwarding is the residual risk (M-2). — https://github.com/vitejs/vite/discussions/10851, https://github.com/vitejs/vite/issues/13522, https://github.com/vitejs/vite/issues/12157
- **create-vite 9.1.2 = npm latest**; react-ts template contents as listed in M-1/H-1 (react ^19.2.8, vite ^8.2.1, typescript ~6.0.2, oxlint; no Vitest). — https://registry.npmjs.org/create-vite/latest, https://raw.githubusercontent.com/vitejs/vite/main/packages/create-vite/template-react-ts/package.json
- **React 19.2.8 = npm latest.** — https://registry.npmjs.org/react/latest
- **TypeScript 7.0.2 = npm latest** (but see H-1: scaffold pins ~6.0.2). — https://registry.npmjs.org/typescript/latest
- **Zustand 5.0.15 = npm latest**; `react` is an *optional* peer dependency, and `zustand/vanilla` `createStore` + `getState`/`setState`/`subscribe` are the supported pattern for driving a store from non-React code (the pipeline's commit path). Caveat noted: middleware-wrapped `set`/`get` don't apply to bare `store.setState` — irrelevant here (no such middleware committed). — https://registry.npmjs.org/zustand/latest, https://github.com/pmndrs/zustand, https://zustand.docs.pmnd.rs/reference/hooks/use-store
- **Vitest 4.1.10 = npm latest**; peer `vite: ^6 || ^7 || ^8` (compatible with Vite 8.2.1); requires Node ≥20; jsdom remains an optional peer/environment; `workspace`→`projects` rename (M-3). — https://registry.npmjs.org/vitest/latest, https://vitest.dev/guide/migration
- **@testing-library/react 16.3.2 = npm latest**; peers `react ^18 || ^19`, `react-dom ^18 || ^19`, `@testing-library/dom ^10` — React 19.2.8 compatible; the trio React 19 + RTL 16 + Vitest 4 is mutually consistent. — https://registry.npmjs.org/@testing-library/react/latest
- **Express 5.2.1 = npm latest**; engines Node ≥18; v5 breaking-change list checked against the spine's REST surface (named params only — unaffected); ws coexistence is at the `http.Server` upgrade layer, outside Express routing — no v5 change touches it; SSE via `res.write` unaffected. — https://registry.npmjs.org/express/latest, https://expressjs.com/en/guide/migrating-5.html
- **ws 8.21.3 = npm latest**; engines Node ≥10. — https://registry.npmjs.org/ws/latest
- **concurrently 10.0.5 = npm latest**; engines Node ≥22 — satisfied by Node 24. — https://registry.npmjs.org/concurrently/latest
- **Node 24 is Active LTS; 24.19.0 released 2026-08-03** — the spine's "24 LTS (24.19.0)" is exactly current. — https://endoflife.date/nodejs
