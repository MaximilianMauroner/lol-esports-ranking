import { useEffect, useMemo, useState } from 'react'
import { currentHashQuery, readModeFromHash, writeNavigationHash } from '../../browser/navigation'
import { canonicalProfileQuery, changeProfileQuery, profileScope, profileSelection } from '../../browser/style/navigation'
import { useStyleProfiles } from '../../browser/style/useStyleProfiles'
import { Button } from '../../components/ui/button'
import { DataState, Segmented, type SegmentedOption } from '../../components/ui'
import { LoadingState } from '../../components/ui/loading'
import { Panel, PanelBody, PanelHeader } from '../../components/ui/panel'
import { Select } from '../../components/ui/select'
import { RouteErrorBoundary } from '../../components/RouteErrorBoundary'
import { RIOT_PROJECT_NOTICE } from '../../data/legal'
import {
  buildStyleCohorts, MIN_GAMES, playerKey, styleMeasures, stylePeers, stylePopulation,
  type StyleEntity, type StyleProfileArtifact,
} from '../../domains/style/profile'
import { AppNavigation, ModeHeader } from '../AppShell'
import { StyleAxisInspector } from './StyleAxisInspector'
import { StyleMeasuresTable } from './StyleMeasuresTable'
import { StyleRadar } from './StyleRadar'
import { StyleTeamPhases } from './StyleTeamPhases'
import { profileReading } from './presentation'
import './style-profiles.css'

const VIEW_OPTIONS: SegmentedOption<'player' | 'team'>[] = [{ value: 'player', label: 'Players' }, { value: 'team', label: 'Teams' }]

function entityKey(entity: StyleEntity) {
  return 'role' in entity ? playerKey(entity) : entity.id
}
function optionLabel(entity: StyleEntity) {
  return `${entity.name} (${'role' in entity ? `${entity.team}, ` : ''}${entity.games} games${entity.games < MIN_GAMES ? ', no percentiles' : ''})`
}

function Profiles({ artifact, query }: { artifact: StyleProfileArtifact; query: URLSearchParams }) {
  const state = useMemo(() => profileSelection(artifact, query), [artifact, query])
  const { view, scope, table, role, league } = state
  const change = (params: Record<string, string>) => changeProfileQuery(params, artifact)
  const population = useMemo(() => stylePopulation(table, view === 'player'
    ? { kind: 'player', role: role ?? 'Jungle' } : { kind: 'team', league: league || null }), [table, view, role, league])
  const cohorts = useMemo(() => buildStyleCohorts(population), [population])
  const entity = view === 'player' ? state.pa : state.ta
  const comparison = view === 'player' ? state.pb : state.tb
  const measures = useMemo(() => entity ? styleMeasures(entity, cohorts) : [], [entity, cohorts])
  const compare = useMemo(() => comparison ? styleMeasures(comparison, cohorts) : undefined, [comparison, cohorts])
  const hasRadarPercentiles = [...measures, ...(compare ?? [])].some(measure => measure.metric.axis && measure.percentile !== null)
  const hasUnavailableAxis = measures.some(measure => hasRadarPercentiles && measure.metric.axis && measure.percentile === null)
    || (compare ?? []).some(measure => measure.metric.axis && measure.percentile === null)
  const axisKey = view === 'player' ? state.paxis : state.taxis
  const selected = measures.find(m => m.metric.key === axisKey) ?? measures[0]
  const selectedCompare = compare?.find(m => m.metric.key === selected?.metric.key)
  const onSelect = (key: string) => change({ [view === 'player' ? 'paxis' : 'taxis']: key })
  const options = [...population].sort((a, b) => a.name.localeCompare(b.name) || entityKey(a).localeCompare(entityKey(b)))
  const peerLabel = view === 'player' ? `${role?.toLowerCase()} players` : league ? `${league} teams` : 'teams from all leagues'
  const sourceContext = <p className="style-scope style-source-context">{scope === 'all' ? 'All recorded years' : `${scope.slice(7)} games`}, through {table.through ?? 'no counted games'}. Oracle's Elixir games with full paired rosters. {table.countedGames.toLocaleString('en-US')} games counted; {table.excludedGames.toLocaleString('en-US')} excluded. Historical records.</p>

  useEffect(() => {
    if (readModeFromHash() !== 'profiles') return
    const canonical = `#profiles?${canonicalProfileQuery(artifact, query).toString()}`
    if (window.location.hash !== canonical) writeNavigationHash(canonical, 'replace')
  }, [artifact, query])

  return <div className="style-profiles">
    <div className="style-controls" data-scope={scope}>
      <div className="style-field style-field-view"><span aria-hidden="true">View</span>
        <Segmented ariaLabel="Profile view" value={view} options={VIEW_OPTIONS} onChange={next => change({ view: next })} /></div>
      <label className="style-field"><span>Scope</span><Select data-wrap aria-label="Scope" value={scope} onChange={e => change({ scope: e.target.value })}>
        <option value="all">All recorded years</option><option value="season:2025">2025</option><option value="season:2026">2026</option>
      </Select></label>
      {view === 'player' ? <label className="style-field"><span>Role</span><Select aria-label="Role" value={role ?? ''} disabled={!state.roles.length} onChange={e => change({ role: e.target.value })}>
        {state.roles.map(role => <option key={role}>{role}</option>)}
      </Select></label> : <label className="style-field"><span>League</span><Select data-wrap aria-label="League" value={league} onChange={e => change({ league: e.target.value })}>
        <option value="">All leagues</option>{state.leagues.map(league => <option key={league}>{league}</option>)}
      </Select></label>}
      <label className="style-field style-field-grow"><span>{view === 'player' ? 'Player' : 'Team'}</span>
        <Select data-wrap aria-label={view === 'player' ? 'Player' : 'Team'} value={entity ? entityKey(entity) : ''} disabled={!entity} onChange={e => change({ [view === 'player' ? 'pa' : 'ta']: e.target.value })}>
          {options.map(entity => <option value={entityKey(entity)} key={entityKey(entity)}>{optionLabel(entity)}</option>)}
        </Select></label>
      <label className="style-field style-field-grow"><span>Compare with</span>
        <Select data-wrap aria-label="Compare with" value={comparison ? entityKey(comparison) : ''} disabled={!entity} onChange={e => change({ [view === 'player' ? 'pb' : 'tb']: e.target.value })}>
          <option value="">No comparison{view === 'player' ? ' (same role only)' : ''}</option>
          {options.filter(row => entity && entityKey(row) !== entityKey(entity)).map(row => <option value={entityKey(row)} key={entityKey(row)}>{optionLabel(row)}</option>)}
        </Select></label>
      <div className="style-scope-summary">
        <p className="style-scope">{table.through ? `Historical ${hasRadarPercentiles ? 'percentiles' : 'records'} through ${table.through}.` : 'Historical records. No counted games.'}</p>
        <p className="style-count-context">{table.countedGames.toLocaleString('en-US')} games counted; {table.excludedGames.toLocaleString('en-US')} excluded.</p>
      </div>
    </div>
    {entity && selected ? <>
      <div className="style-stage">
        <Panel className="style-radar-panel" aria-labelledby="style-entity-title">
          <header className="style-entity-head"><div className="style-series-a"><h2 id="style-entity-title"><span className="style-swatch" aria-hidden="true" />{entity.name}</h2>
            <p className="style-muted">{'role' in entity ? `${entity.role}, ${entity.team}. ` : `${entity.league ?? 'Home league not recorded'}. `}{entity.games} games.</p>
            {entity.games < MIN_GAMES ? <p className="style-sample-note">Under 20 games. No percentiles.</p> : null}</div>
            {comparison ? <div className="style-comparison-head style-series-b"><p className="style-muted">Compared with</p><h3><span className="style-swatch" aria-hidden="true" />{comparison.name}</h3>
              <p className="style-muted">{'role' in comparison ? `${comparison.team}. ` : ''}{comparison.games} games.</p>
              {comparison.games < MIN_GAMES ? <p className="style-sample-note">Under 20 games. No percentiles.</p> : null}</div> : null}
          </header>
          <p className="style-reading">{profileReading(measures, compare, comparison?.name)}</p>
          <StyleRadar measures={measures} compare={compare} selected={selected.metric.key} onSelect={onSelect} name={entity.name} compareName={comparison?.name} />
          <div className="style-legend"><span className="style-series-a"><span className="style-swatch" aria-hidden="true" />{entity.name}</span>
            {comparison ? <span className="style-series-b"><span className="style-swatch" aria-hidden="true" />{comparison.name}</span> : null}
            <p>{hasRadarPercentiles
              ? <>Distance is the percentile among {peerLabel}. The middle ring is the median. Coverage can differ by measure. Shape size is not a score or rank.</>
              : <>The sample rules do not permit percentiles here. Raw values and coverage remain in All measures.</>}{hasUnavailableAxis ? ' n/a means no percentile is available.' : null}</p>
          </div>
        </Panel>
        <StyleAxisInspector entity={entity} measure={selected} compareEntity={comparison} compare={selectedCompare}
          peers={stylePeers(entity, selected.metric.key, cohorts)} peerLabel={peerLabel} />
      </div>
      {sourceContext}
      {view === 'team' && state.ta ? <StyleTeamPhases teams={[state.ta, ...(state.tb ? [state.tb] : [])]} measures={[measures, ...(compare ? [compare] : [])]} /> : null}
      <StyleMeasuresTable measures={measures} compare={compare} name={entity.name} compareName={comparison?.name} selected={selected.metric.key} onSelect={onSelect} peerLabel={peerLabel} />
      <Panel><PanelHeader title="Not measured here" description="These profiles do not show the following measures." />
        <PanelBody><ul className="style-notes"><li>Ward positions and ward quality.</li><li>Objective timing, fight events and gold curves after 15 minutes.</li>
          <li>Champion breadth and draft tendencies are outside this profile.</li></ul></PanelBody>
      </Panel>
    </> : <><Panel><DataState icon={null} title="No profiles in this scope">Choose another scope to see recorded profiles.</DataState></Panel>{sourceContext}</>}
    <details className="style-provenance"><summary>Source and sample rules</summary>
      <p>Definition {artifact.definitionVersion}. Each mean gives equal weight to a recorded game. Year scopes use the game date. No ranking scores change.</p>
      <p>Excluded games include {table.excludedByReason['other-provider']} from other providers, {table.excludedByReason['incomplete-pair']} without complete pairs and {table.excludedByReason['missing-team-id']} without distinct team IDs.</p>
      <p>Input SHA-256 <code>{artifact.sourceSha256}</code>.</p>
    </details>
  </div>
}

export function StyleProfileRoute() {
  const { state, retry } = useStyleProfiles()
  const [query, setQuery] = useState(currentHashQuery)
  useEffect(() => {
    const restore = () => {
      if (readModeFromHash() === 'profiles') setQuery(currentHashQuery())
    }
    window.addEventListener('hashchange', restore)
    window.addEventListener('popstate', restore)
    return () => { window.removeEventListener('hashchange', restore); window.removeEventListener('popstate', restore) }
  }, [])
  const scope = profileScope(query.get('scope'))
  return <div className="flex min-h-full flex-col">
    <a className="fixed top-[-56px] left-3 z-80 rounded-md border border-[var(--accent-line)] bg-[var(--surface-2)] px-3 py-2 text-sm font-semibold text-[var(--text-strong)] no-underline shadow-[var(--shadow-2)] focus-visible:top-3" href="#main-content" onClick={e => { e.preventDefault(); document.getElementById('main-content')?.focus(); document.getElementById('main-content')?.scrollIntoView({ block: 'start' }) }}>Skip to content</a>
    <AppNavigation mode="profiles" scope={scope} />
    <main id="main-content" tabIndex={-1} className="min-w-0 pb-6 max-sm:pb-[calc(var(--tabbar-h)+24px)]">
      <ModeHeader mode="profiles" />
      <RouteErrorBoundary>
        {state.status === 'loading' ? <LoadingState presentation="page" layout="board" label="Loading style profiles" />
          : state.status === 'error' ? <section className="px-[var(--page-x)] pt-6"><Panel><DataState icon={null} title="Style profiles could not be loaded"
            action={<Button onClick={retry}>Retry</Button>}>{state.message}</DataState></Panel></section>
            : <Profiles artifact={state.data} query={query} />}
      </RouteErrorBoundary>
      <footer className="px-[var(--page-x)] pt-6 text-xs text-muted-foreground">{RIOT_PROJECT_NOTICE}</footer>
    </main>
  </div>
}
