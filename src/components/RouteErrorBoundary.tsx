import { Component, type ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Button } from './ui/button'

export class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <section className="mx-auto w-full max-w-xl px-4 py-12">
        <Alert variant="destructive">
          <AlertTitle>This page could not load</AlertTitle>
          <AlertDescription>
            <p>Reload the page to try again.</p>
            <Button type="button" variant="outline" onClick={() => window.location.reload()}>Reload page</Button>
          </AlertDescription>
        </Alert>
      </section>
    )
  }
}
