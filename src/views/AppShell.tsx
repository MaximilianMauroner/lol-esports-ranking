import { AlertTriangle, RefreshCw, Search } from 'lucide-react'
import { type MouseEvent, type RefObject } from 'react'
import { hashForModeAndScope } from '../browser/navigation'
import type { PublicSnapshotState } from '../browser/rankings/usePublicArtifacts'
import {
  scopeLabel
} from '../browser/rankings/usePublicArtifacts'
import { DataState } from '../components/ui'
import { Button, buttonVariants } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { LoadingState, type PageLayout } from '../components/ui/loading'
import { cn } from '../shared/utils'
import { preloadView } from './rankings/routeLoading'
import { MODE_TITLES, MODES, PAGE_LAYOUTS, type Mode } from './shellConfig'

export function ManifestRouteShell({
  mode,
  scope,
  onGoHome,
  error,
}: {
  mode: Mode
  scope: string
  onGoHome?: (event: MouseEvent<HTMLAnchorElement>) => void
  error?: string
}) {
  return (
    <div className="flex min-h-full flex-col">
      <a className="fixed top-[-56px] left-3 z-80 rounded-md border border-[var(--accent-line)] bg-[var(--surface-2)] px-3 py-2 text-sm font-semibold text-[var(--text-strong)] no-underline shadow-[var(--shadow-2)] focus-visible:top-3" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus(); document.getElementById('main-content')?.scrollIntoView({ block: 'start' }) }}>Skip to content</a>
      <AppNavigation mode={mode} scope={scope} onGoHome={onGoHome} />
      <main id="main-content" className="flex min-w-0 flex-col" tabIndex={-1}>
        <ModeHeader mode={mode} />
        {mode !== 'tournaments' ? <div className="flex min-h-[57px] items-center border-b border-border bg-[color-mix(in_oklch,var(--surface)_76%,var(--bg))] px-[var(--page-x)] py-2 text-sm text-muted-foreground max-sm:min-h-[141px]">
          Requested scope: <b className="ml-2 text-foreground">{scopeLabel(scope)}</b>
        </div> : null}
        {error ? (
          <section className="px-[var(--page-x)] pt-6">
            <Card role="alert">
              <DataState
                icon={<AlertTriangle size={26} aria-hidden="true" />}
                title="Rankings could not be loaded"
                action={
                  <Button type="button" variant="default" onClick={() => window.location.reload()}>
                    <RefreshCw size={15} aria-hidden="true" />
                    Retry
                  </Button>
                }
              >
                {error}
              </DataState>
            </Card>
          </section>
        ) : (
          <LoadingState presentation="page" layout={PAGE_LAYOUTS[mode]} label={`Loading ${MODE_TITLES[mode].title}`} />
        )}
      </main>
    </div>
  )
}

/**
 * Title and the one explanatory line, rendered in the same slot for every view
 * so no view can ship without one.
 */
export function ModeHeader({ mode }: { mode: Mode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-[var(--page-x)] pt-4 pb-3">
      <h1 className="text-xl font-semibold tracking-normal text-[var(--text-strong)]">{MODE_TITLES[mode].title}</h1>
      <p className="max-w-[80ch] text-sm leading-[1.5] text-muted-foreground">{MODE_TITLES[mode].intro}</p>
    </div>
  )
}

export function AppNavigation({
  mode,
  scope,
  onGoHome,
  search,
  onSearch,
  searchRef,
  onIntent,
}: {
  mode: Mode
  scope: string
  onGoHome?: (event: MouseEvent<HTMLAnchorElement>) => void
  search?: string
  onSearch?: (value: string) => void
  searchRef?: RefObject<HTMLInputElement | null>
  onIntent?: (mode: Mode) => void
}) {
  const tabs = MODES.map((entry) => {
    const Icon = entry.icon
    return (
      <a
        key={entry.id}
        href={hashForModeAndScope(entry.id, scope)}
        className={cn(
          buttonVariants({ variant: 'tab', size: 'tab' }),
          'min-w-0 shrink-0 gap-2 font-semibold no-underline max-sm:h-full max-sm:flex-1 max-sm:flex-col max-sm:gap-0.5 max-sm:rounded-none max-sm:border-0 max-sm:text-2xs',
        )}
        aria-current={mode === entry.id ? 'page' : undefined}
        onPointerEnter={() => (onIntent ?? preloadView)(entry.id)}
        onFocus={() => (onIntent ?? preloadView)(entry.id)}
        onTouchStart={() => (onIntent ?? preloadView)(entry.id)}
      >
        <Icon size={17} className="sm:max-lg:hidden" aria-hidden="true" />
        {entry.label}
      </a>
    )
  })

  return (
    <>
      <header className="sticky top-0 z-50 flex min-h-[var(--app-nav-h)] items-center gap-x-4 border-b border-border bg-[var(--rail)]/98 px-[var(--page-x)] py-2.5 max-[900px]:px-3">
        <a className="flex min-w-0 shrink-0 items-center gap-2.5 rounded-md py-1 pr-2 text-left text-inherit no-underline transition-colors hover:bg-[color-mix(in_oklab,var(--surface-2)_46%,transparent)]" href={hashForModeAndScope('rankings', scope)} onClick={onGoHome} title="Go to Rankings home">
          <img className="block size-9 shrink-0 rounded-md" src="/logo.svg" alt="" aria-hidden="true" width={36} height={36} />
          <b className="block overflow-hidden text-ellipsis whitespace-nowrap text-md font-semibold text-[var(--text-strong)] max-[420px]:sr-only sm:max-lg:sr-only">Power Index</b>
        </a>
        {/* The active tab uses the shared selected treatment. Gold stays
            reserved for rank quality. The tabs never shrink: the search gives
            way instead, and between the phone tab bar and desktop the
            wordmark, tab icons and shortcut hint make room for it. */}
        <nav className="flex shrink-0 items-center gap-1.5 max-sm:hidden" aria-label="Primary">{tabs}</nav>
        {onSearch ? (
          <label className="relative ml-auto w-[min(280px,100%)] min-w-0 max-sm:flex-1">
            <span className="sr-only">Find a team</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--faint)]" aria-hidden="true" />
            <Input
              ref={searchRef}
              type="search"
              className="pl-9 lg:pr-9"
              value={search ?? ''}
              placeholder="Find a team"
              aria-keyshortcuts="/"
              onChange={(event) => onSearch(event.target.value)}
            />
            <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded-sm border border-[var(--line-strong)] px-1.5 font-mono text-2xs text-[var(--faint)] max-lg:hidden" aria-hidden="true">/</kbd>
          </label>
        ) : null}
      </header>
      {/* Phones get the views as a bottom tab bar, so the top of the screen
          holds data instead of three full-width buttons. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-50 flex h-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] items-stretch border-t border-border bg-[var(--rail)] pb-[env(safe-area-inset-bottom)] sm:hidden"
        aria-label="Primary"
      >
        {tabs}
      </nav>
    </>
  )
}

export function ScopedSnapshotState({ state, scope, layout }: { state: Exclude<PublicSnapshotState, { status: 'ready' }>; scope: string; layout: PageLayout }) {
  if (state.status === 'loading') {
    return <LoadingState presentation="page" layout={layout} label={`Loading ${scope}`} />
  }
  return (
    <section className="flex min-w-0 flex-col px-[var(--page-x)] pt-6">
      <Card>
        <DataState icon={<AlertTriangle size={26} aria-hidden="true" />} title={`Snapshot unavailable for ${scope}`}>
          {state.message}
        </DataState>
      </Card>
    </section>
  )
}

export function ErrorScreen({ message }: { message: string }) {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <Card className="w-[min(460px,92vw)] shadow-[var(--shadow-2)]">
        <DataState
          icon={<AlertTriangle size={26} aria-hidden="true" />}
          title="Snapshot unavailable"
          action={
            <Button type="button" variant="default" onClick={() => window.location.reload()}>
              <RefreshCw size={15} aria-hidden="true" />
              Retry
            </Button>
          }
        >
          {message}
        </DataState>
      </Card>
    </main>
  )
}
