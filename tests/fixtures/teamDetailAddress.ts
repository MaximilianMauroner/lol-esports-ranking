import type { Plugin } from 'vite'
import { createStaticRankingData } from '../../src/domains/rankings/internal/projections/snapshot.ts'
import { createPublicArtifactWritePlan } from '../../src/domains/rankings/internal/published/writePlan.ts'
import type { MatchRecord, TeamProfile } from '../../src/domains/rankings/types.ts'

export const teamIds = { alpha: 'team:sya:synthetic-alpha', beta: 'team:syb:synthetic-beta', retired: 'team:syr:synthetic-retired' }

export function createTeamDetailFixture() {
  const teams: Record<string, TeamProfile> = Object.fromEntries(['Alpha', 'Beta', 'Retired'].map((name, index) => {
    const fullName = `Synthetic ${name}`
    return [fullName, { name: fullName, code: ['SYA', 'SYB', 'SYR'][index], league: 'LCK', region: 'LCK' }]
  }))
  const matches: MatchRecord[] = [2025, 2026].flatMap((season) => Array.from({ length: 12 }, (_, index) => {
    const date = `${season}-01-${String(index + 1).padStart(2, '0')}`
    const tournament = season === 2025 && (index === 9 || index === 11)
    return { id: `synthetic-${season}-${index}`, sourceProvider: 'oracles-elixir', date, datetimeUtc: `${date}T12:00:00.000Z`, season,
      event: tournament ? 'MSI 2025' : `Synthetic LCK ${season}`, phase: tournament ? 'Bracket' : 'Regular season',
      region: tournament ? 'International' : 'LCK', league: tournament ? 'MSI' : 'LCK', patch: '', bestOf: 1, bestOfBasis: 'provider',
      tier: tournament ? 'msi-bracket' : 'regional-regular', teamA: 'Synthetic Alpha',
      teamB: season === 2025 && index % 2 === 0 ? 'Synthetic Retired' : 'Synthetic Beta',
      winner: index % 3 === 0 ? 'Synthetic Alpha' : season === 2025 && index % 2 === 0 ? 'Synthetic Retired' : 'Synthetic Beta',
      teamAKills: 15, teamBKills: 9, teamAGold: 60_000, teamBGold: 55_000 }
  }))
  const data = createStaticRankingData({ matches, teams, rosters: {}, generatedAt: '2026-02-01T00:00:00.000Z', dataMode: 'seeded-sample' })
  const plan = createPublicArtifactWritePlan(data)
  const bodies = new Map(plan.writes.map((write) => [`/data/${write.relativePath}`, write.contents]))
  const requests: string[] = []
  const held = new Set<string>()
  const failed = new Set<string>()
  const pending = new Map<string, Array<() => void>>()
  function release(path: string) {
    held.delete(path)
    pending.get(path)?.splice(0).forEach((respond) => respond())
  }
  const plugin: Plugin = { name: 'synthetic-team-detail-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
      if (path.startsWith('/tournament-data/') || path.startsWith('/api/')) {
        response.statusCode = 503
        response.end('{}')
        return
      }
      if (!path.startsWith('/data/')) return next()
      requests.push(path)
      const respond = () => {
        const body = failed.has(path) ? undefined : bodies.get(path)
        response.statusCode = body ? 200 : 404
        response.setHeader('content-type', 'application/json')
        response.end(body ?? '{}')
      }
      if (!held.has(path)) return respond()
      const waiting = pending.get(path) ?? []
      waiting.push(respond)
      pending.set(path, waiting)
    })
  } }
  return { matches, plan, bodies, requests, held, failed, pending, release, plugin }
}
