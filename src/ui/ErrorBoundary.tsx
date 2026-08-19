// FleetPulse — per-widget error boundary (FR-28)
//
// The shell (`app/App.tsx`) wraps every registered widget in one of these
// so a throwing widget is contained: its own fallback renders in place,
// every sibling widget keeps working. React error boundaries must be class
// components — there is no hook equivalent.

import { Component, type ErrorInfo, type ReactNode } from 'react'
import styles from './ErrorBoundary.module.css'

export interface ErrorBoundaryProps {
  /** Shown in the contained fallback so a dispatcher can tell which panel
   * broke without the rest of the dashboard going down with it. */
  widgetTitle: string
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Contained, not silent: surfaced to the console for diagnosis while
    // the rest of the dashboard keeps working (FR-28) — no telemetry sink
    // exists yet to report this to instead.
    console.error(`[widget error: ${this.props.widgetTitle}]`, error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className={styles.fallback} role="alert">
          <strong>{this.props.widgetTitle}</strong> failed to render.
        </div>
      )
    }
    return this.props.children
  }
}
