import {
  PLAYER_METRICS, ROLES, TEAM_METRICS, playerKey,
  type StyleProfileArtifact,
} from '../../domains/style/profile'
import { currentHashQuery, profileScope, writeNavigationHash } from '../navigation'

export { profileScope } from '../navigation'

export function profileSelection(artifact: StyleProfileArtifact, query: URLSearchParams) {
  const scope = profileScope(query.get('scope'))
  const table = artifact.scopes[scope]
  const requested = table.players.find(player => playerKey(player) === query.get('pa'))
  const roles = ROLES.filter(role => table.players.some(player => player.role === role))
  const role = roles.find(role => role === query.get('role')) ?? requested?.role ?? (roles.includes('Jungle') ? 'Jungle' : roles[0])
  const players = table.players.filter(player => player.role === role)
  const pa = players.find(player => playerKey(player) === query.get('pa'))
    ?? players.find(player => player.name === 'Tarzan') ?? [...players].sort((a, b) => b.games - a.games)[0]
  const pb = players.find(player => playerKey(player) === query.get('pb') && playerKey(player) !== (pa && playerKey(pa)))
  const leagues = [...new Set(table.teams.flatMap(team => team.league === null ? [] : [team.league]))].sort()
  const league = leagues.includes(query.get('league') ?? '') ? query.get('league')! : ''
  const teams = table.teams.filter(team => !league || team.league === league)
  const ta = teams.find(team => team.id === query.get('ta')) ?? teams.find(team => team.name === 'Gen.G')
    ?? [...teams].sort((a, b) => b.games - a.games)[0]
  const tb = teams.find(team => team.id === query.get('tb') && team.id !== ta?.id)
  const paxis = PLAYER_METRICS.find(metric => metric.key === query.get('paxis'))?.key ?? PLAYER_METRICS[0].key
  const taxis = TEAM_METRICS.find(metric => metric.key === query.get('taxis'))?.key ?? TEAM_METRICS[0].key
  return { scope, table, roles, role, players, pa, pb, leagues, league, teams, ta, tb, paxis, taxis,
    view: query.get('view') === 'team' ? 'team' as const : 'player' as const }
}

export function canonicalProfileQuery(artifact: StyleProfileArtifact, query: URLSearchParams) {
  const state = profileSelection(artifact, query)
  const next = new URLSearchParams(query)
  const values = { scope: state.scope, view: state.view, role: state.role, league: state.league,
    pa: state.pa && playerKey(state.pa), pb: state.pb && playerKey(state.pb), paxis: state.paxis,
    ta: state.ta?.id, tb: state.tb?.id, taxis: state.taxis }
  for (const [key, value] of Object.entries(values)) {
    if (value) next.set(key, value)
    else next.delete(key)
  }
  return next
}

export function changeProfileQuery(params: Record<string, string>, artifact: StyleProfileArtifact) {
  const next = currentHashQuery()
  for (const [key, value] of Object.entries(params)) {
    if (value) next.set(key, value)
    else next.delete(key)
  }
  const query = canonicalProfileQuery(artifact, next)
  const hash = `#profiles?${query.toString()}`
  if (hash === window.location.hash) return
  writeNavigationHash(hash, 'push')
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}
