// FleetPulse — composition root: widget shell (AD-6)
//
// Mounts bootstrap once (idempotent — safe under StrictMode's dev
// double-invoke) and renders every registered widget inside its own
// `ErrorBoundary` (FR-28). The side-effect import below is the "one import
// line" AD-6 asks for when a widget is added — never an edit to the widget
// module itself, and never an edit to this list's existing entries.

import { useEffect } from 'react'
import { getBootstrap } from './bootstrap.ts'
import { getWidgets } from '../ui/registry.ts'
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx'
import '../ui/widgets/fleetOverview/FleetOverview.tsx'
import styles from './App.module.css'

export default function App() {
  useEffect(() => {
    getBootstrap()
  }, [])

  const widgets = getWidgets()

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1>FleetPulse</h1>
      </header>
      <main className={styles.main}>
        {widgets.map((widget) => (
          <ErrorBoundary key={widget.id} widgetTitle={widget.title}>
            <widget.component />
          </ErrorBoundary>
        ))}
      </main>
    </div>
  )
}
