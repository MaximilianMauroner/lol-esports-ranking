import { Suspense, useCallback, useRef, useState, type MouseEvent } from 'react'
import { hashForModeAndScope, readScopeFromHash, writeNavigationHash } from '../../browser/navigation'
import { RouteErrorBoundary } from '../../components/RouteErrorBoundary'
import { LoadingState } from '../../components/ui/loading'
import { currentSeasonScope } from '../../domains/rankings/read'
import { AppNavigation, ModeHeader } from '../AppShell'
import { TournamentsView } from './routeLoading'

export function TournamentRoute() {
  const [scope] = useState(() => readScopeFromHash() ?? currentSeasonScope())
  const mainRef = useRef<HTMLElement | null>(null)
  const goHome = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    writeNavigationHash(hashForModeAndScope('rankings', scope), 'navigate')
  }, [scope])
  return <div className="flex min-h-full flex-col">
    <a className="fixed top-[-56px] left-3 z-80 rounded-md border border-[var(--accent-line)] bg-[var(--surface-2)] px-3 py-2 focus-visible:top-3" href="#main-content" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); mainRef.current?.scrollIntoView({ block: 'start' }) }}>Skip to content</a>
    <AppNavigation mode="tournaments" scope={scope} onGoHome={goHome} />
    <main id="main-content" tabIndex={-1} ref={mainRef} className="min-w-0 flex-1 pb-6 max-sm:pb-[calc(var(--tabbar-h)+24px+env(safe-area-inset-bottom))]">
      <ModeHeader mode="tournaments" />
      <RouteErrorBoundary key="tournaments">
        <Suspense fallback={<LoadingState presentation="page" layout="schedule" label="Loading Tournaments" />}>
          <TournamentsView />
        </Suspense>
      </RouteErrorBoundary>
    </main>
  </div>
}
