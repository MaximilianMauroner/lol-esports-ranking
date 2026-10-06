import type { EvaluationRow } from '../../src/lib/rankingEvaluation'

export type LeagueFit = ReturnType<typeof fitHierarchicalLeagues>

/** Offline ridge Bradley-Terry prototype. Team effects model selected entrants explicitly. */
export function fitHierarchicalLeagues(rows: readonly EvaluationRow[], priors: ReadonlyMap<string, number>, anchor: string, priorPrecision = 2) {
  if (!priors.has(anchor) || !Number.isFinite(priorPrecision) || priorPrecision <= 0) throw new Error('Invalid hierarchy anchor or precision')
  const eligible = rows.filter((row) => row.leagueA !== 'Unknown' && row.leagueB !== 'Unknown' && priors.has(row.leagueA) && priors.has(row.leagueB))
  const teamKey = (team: string, league: string) => `${league}\u0000${team}`
  const teams = new Map<string, { league: string; value: number; information: number; domesticGames: number }>()
  const leagues = new Map([...priors].map(([league, prior]) => [league,
    { value: prior - priors.get(anchor)!, prior: prior - priors.get(anchor)!, information: priorPrecision, crossGames: 0, neighbors: new Set<string>() }]))
  for (const row of eligible) {
    for (const [team, league] of [[row.teamA, row.leagueA], [row.teamB, row.leagueB]]) {
      const key = teamKey(team, league)
      const member = teams.get(key) ?? { league, value: 0, information: 4, domesticGames: 0 }
      if (row.leagueA === row.leagueB) member.domesticGames += 1
      teams.set(key, member)
    }
    if (row.leagueA !== row.leagueB) {
      for (const [league, opponent] of [[row.leagueA, row.leagueB], [row.leagueB, row.leagueA]]) {
        leagues.get(league)!.crossGames += 1; leagues.get(league)!.neighbors.add(opponent)
      }
    }
  }
  const leagueMembers = new Map([...leagues.keys()].map((league) => [league, [...teams.values()].filter((team) => team.league === league)]))
  const probability = (teamA: string, leagueA: string, teamB: string, leagueB: string) => {
    const strength = (team: string, league: string) => (leagues.get(league)?.value ?? 0) + (teams.get(teamKey(team, league))?.value ?? 0)
    return 1 / (1 + Math.exp(strength(teamB, leagueB) - strength(teamA, leagueA)))
  }
  for (let iteration = 0; iteration < 160; iteration += 1) {
    const teamGradients = new Map([...teams].map(([key, team]) => [key, -4 * team.value]))
    const leagueGradients = new Map([...leagues].map(([key, league]) => [key, -priorPrecision * (league.value - league.prior)]))
    for (const team of teams.values()) team.information = 4
    for (const league of leagues.values()) league.information = priorPrecision
    for (const row of eligible) {
      const p = probability(row.teamA, row.leagueA, row.teamB, row.leagueB)
      const residual = row.actual - p
      const information = p * (1 - p)
      for (const [team, league, sign] of [[row.teamA, row.leagueA, 1], [row.teamB, row.leagueB, -1]] as const) {
        const key = teamKey(team, league)
        teamGradients.set(key, teamGradients.get(key)! + sign * residual)
        teams.get(key)!.information += information
        if (row.leagueA !== row.leagueB) {
          leagueGradients.set(league, leagueGradients.get(league)! + sign * residual)
          leagues.get(league)!.information += information
        }
      }
    }
    for (const [key, team] of teams) team.value += .3 * teamGradients.get(key)! / team.information
    // Zero mean over observed domestic members, not over international entrants.
    for (const members of leagueMembers.values()) {
      const domesticMembers = members.filter((team) => team.domesticGames > 0)
      if (!domesticMembers.length) continue
      const mean = domesticMembers.reduce((total, team) => total + team.value, 0) / domesticMembers.length
      for (const team of members) team.value -= mean
    }
    for (const [key, league] of leagues) {
      if (key === anchor) league.value = 0
      else league.value += .3 * leagueGradients.get(key)! / league.information
    }
  }
  const connected = new Set([anchor])
  const pending = [anchor]
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) for (const neighbor of leagues.get(next)!.neighbors) {
    if (!connected.has(neighbor)) { connected.add(neighbor); pending.push(neighbor) }
  }
  return { probability, teams: [...teams].map(([key, team]) => ({ key, ...team })),
    leagues: [...leagues].map(([league, value]) => ({ league, logitOffset: value.value, crossGames: value.crossGames,
      domesticMembers: leagueMembers.get(league)!.filter((team) => team.domesticGames > 0).length,
      diagonalScale: 1 / Math.sqrt(value.information), connected: connected.has(league),
      neighbors: [...value.neighbors].sort(), provisional: !connected.has(league) || value.crossGames < 20
        || !leagueMembers.get(league)!.some((team) => team.domesticGames > 0) })),
    uncertaintyPolicy: 'diagonal-curvature-diagnostic; not calibrated confidence intervals', excluded: rows.length - eligible.length }
}
