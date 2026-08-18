# FleetPulse

A real-time fleet-dispatch dashboard: a self-built mock server plus a React/TypeScript
client giving a dispatcher a live, trustworthy picture of a 12-truck fleet — telemetry
they can trust, presence, route lifecycle with concurrency-safe conflict resolution, and
resilience under a deliberately unreliable stream.

> This README is a placeholder for local orientation. The full write-up (data-flow
> walkthrough, the tire-pressure extensibility example, traceability from requirement to
> implementation to test) lands in the final story per
> `_bmad-output/implementation-artifacts/epic-1-context.md`.

## Run it

Requires Node 24 LTS (see `.nvmrc`).

```bash
npm install
npm start   # server.js (:3000) + Vite dev client, concurrently
npm test    # vitest run
```

`npm start`'s server leg has nothing to run until `server.js` lands; until then use
`npm run dev` for the client alone.

## Project docs

- Spec: `_bmad-output/specs/spec-Fleet-Pulse/SPEC.md`
- Architecture: `_bmad-output/planning-artifacts/architecture/architecture-Fleet-Pulse-2026-08-18/ARCHITECTURE-SPINE.md`
- Decisions log: `DECISIONS.md`

---

_Scaffolded from `create-vite` (react-ts). Oxlint config and React Compiler notes below
are the template's own, kept as-is per the architecture's lint convention._

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
