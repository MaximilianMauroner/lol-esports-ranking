import { createServer, type Plugin } from 'vite'
import { createStaticRankingData } from '../../src/lib/snapshot'
import { createPublicArtifactWritePlan } from '../../src/lib/publicArtifacts/writePlan'
import { emptyForecastLedger, type ForecastBasis } from '../../src/lib/tournamentForecast'
import type { MatchRecord, TeamProfile } from '../../src/types'
import { worldsFixture, worldsEvent, worldsFeed, worldsArtifact, historicalWorldsFixture } from './worldsFixtures'
import { worldsFeedEventKey, type WorldsArtifact } from '../../src/lib/worldsArtifacts'

export type WorldsFixtureControls = { stage: 'play-in' | 'swiss-5' | 'knockout' | 'completed' | 'historical' | 'historical-tie'; corrupt: boolean; missingModel: boolean; live: boolean; revision: number }

/** Entirely local artifacts. No public/data replacement, external request or producer activation. */
export async function createWorldsFixtureServer(port = 0) {
  const input = worldsFixture()
  const ids = [...input.directEntrants, ...input.playIn.entrants].map((team) => team.id)
  const teams: Record<string, TeamProfile> = Object.fromEntries(ids.map((id) => [`Fixture ${id}`, { name: `Fixture ${id}`, code: id, region: 'LCK', league: 'LCK' }]))
  const matches: MatchRecord[] = ids.flatMap((id, index) => [0, 1].map((leg) => ({ id: `synthetic-history-${index}-${leg}`, sourceProvider: 'seed',
    date: '2026-10-16', season: 2026, event: 'Synthetic offline ranking evidence', region: 'LCK', league: 'LCK', phase: 'Regular season', tier: 'regional-regular',
    teamA: `Fixture ${id}`, teamB: `Fixture ${ids[(index + 1) % ids.length]}`, winner: `Fixture ${leg ? ids[(index + 1) % ids.length] : id}`,
    bestOf: 1, bestOfBasis: 'official', patch: '26.1', teamAKills: 10, teamBKills: 10, teamAGold: 50_000, teamBGold: 50_000 })))
  const data = createStaticRankingData({ matches, teams, rosters: {}, generatedAt: '2026-10-17T01:00:00Z', source: 'Synthetic offline Worlds UI verification',
    dataMode: 'seeded-sample', materializeSnapshotKeys: new Set(['All__All__All']), materializeTournamentIds: new Set() })
  const plan = createPublicArtifactWritePlan(data)
  const snapshot = plan.snapshots[plan.manifest.defaultSnapshotKey]
  const identityMap: ForecastBasis['identityMap'] = { version: 1, source: 'lolesports-persisted-site-api', revision: 'synthetic-worlds-browser-identity',
    mappings: ids.map((id) => {
      const row = snapshot.standings.find((standing) => standing.team === `Fixture ${id}`)
      if (!row) throw new Error(`Missing fixture rating ${id}`)
      return { sourceTeamId: id, teamId: row.teamId }
    }) }
  const controls: WorldsFixtureControls = { stage: 'swiss-5', corrupt: false, missingModel: false, live: false, revision: 0 }
  const artifactBodies = new Map(plan.writes.map((write) => [`/data/${write.relativePath}`, write.contents]))
  function current() {
    if (controls.stage === 'historical' || controls.stage === 'historical-tie') {
      const state = historicalWorldsFixture()
      if (controls.stage === 'historical-tie') state.group.games.find((game) => game.id === 'past-1-2-1')!.winnerId = 'past-gamma'
      const event = { ...worldsEvent(), id: state.eventId, season: '2022', label: 'Worlds 2022 · synthetic observed group', series: [] }
      const artifact: WorldsArtifact = { version: 1, eventId: event.id, feedEventKey: worldsFeedEventKey(event), dataMode: 'synthetic-fixture', state }
      return { event, artifact }
    }
    const state = worldsFixture(controls.stage)
    for (const stage of [state.playIn, state.swiss, state.knockout]) if (stage) stage.stateVersion += `/${controls.revision}`
    const event = worldsEvent(state)
    if (controls.live) event.series.push({ id: 'fixture-live-swiss', eventId: event.id, startTime: null, stage: 'Swiss round 5',
      status: 'live', sourceState: 'inProgress', bestOf: 3, vodUrls: [],
      teams: ['LCK2', 'CBLOL1'].map((id, slot) => ({ id, name: `Fixture ${id}`, code: id, gameWins: slot === 0 ? 1 : 0, outcome: null })) })
    const artifact = worldsArtifact(state, event)
    if (controls.corrupt) artifact.feedEventKey = 'stale-fixture-revision'
    return { event, artifact }
  }
  const plugin: Plugin = { name: 'worlds-offline-browser-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname
      if (path === '/__worlds-fixture' && request.method === 'POST') {
        let text = ''
        request.on('data', (chunk) => { text += chunk })
        request.on('end', () => { Object.assign(controls, JSON.parse(text)); response.end('Fixture controls changed.') })
        return
      }
      if (path === '/__worlds-fixture') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ controls, ...current() })); return }
      if (artifactBodies.has(path)) { response.setHeader('content-type', 'application/json'); response.end(artifactBodies.get(path)); return }
      if (!path.startsWith('/tournament-data/')) return next()
      const { event, artifact } = current()
      const body = path === '/tournament-data/feed.json' ? worldsFeed(event)
        : path === '/tournament-data/feed.json.health.json' ? { checkedAt: new Date().toISOString(), complete: true, warnings: [] }
          : path === '/tournament-data/forecasts/team-ids.json' ? controls.missingModel ? null : identityMap
            : path === '/tournament-data/forecasts/ledger.json' ? emptyForecastLedger
              : path === `/tournament-data/worlds/${encodeURIComponent(event.id)}.json` ? artifact : null
      response.statusCode = body ? 200 : 404
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body))
    })
  } }
  const server = await createServer({ publicDir: false, logLevel: 'silent', server: { host: '127.0.0.1', port, strictPort: true }, plugins: [plugin],
    define: { 'import.meta.env.VITE_TOURNAMENT_HUB_ENABLED': JSON.stringify('1'), 'import.meta.env.VITE_TOURNAMENT_FORECASTS_ENABLED': JSON.stringify('1') } })
  return { server, controls, current, plan }
}
