// FleetPulse — widget registry (AD-6)
//
// One of the three registration seams the architecture spine names: adding
// a widget is a new module under `ui/widgets/` that calls `registerWidget()`
// once at its own module load (mirrors `pipeline/signals/registry.ts`'s own
// pattern), plus one side-effect import line where widgets are collected
// (`app/App.tsx`) — never an edit to an existing widget module.

import type { ComponentType } from 'react'

export interface WidgetDefinition {
  /** Stable, unique identifier — also used as the React key and the
   * `ErrorBoundary` scope label when the shell mounts this widget (FR-28). */
  id: string
  /** Human-readable label shown in this widget's error fallback and
   * available to the shell for layout — a widget's own internal layout is a
   * free build-time choice (spine's Deferred: "widget-level component
   * breakdown & layout"). */
  title: string
  component: ComponentType
}

const registry = new Map<string, WidgetDefinition>()

export function registerWidget(definition: WidgetDefinition): void {
  // AD-6's extensibility promise ("new module + one register() call") only
  // holds if a name collision fails loudly — a silent overwrite here would
  // leave whichever widget registered second quietly shadowing the first.
  if (registry.has(definition.id)) {
    throw new Error(`widget "${definition.id}" is already registered`)
  }
  registry.set(definition.id, definition)
}

export function getWidgets(): WidgetDefinition[] {
  return [...registry.values()]
}

/** Test-only: clears every registration. Production code never calls this
 * — widget modules register once at import time and stay registered for
 * the process lifetime. */
export function resetRegistryForTests(): void {
  registry.clear()
}
