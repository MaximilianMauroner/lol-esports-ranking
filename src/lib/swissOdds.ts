import { SWISS_ROUND_SIZES, drawContext, pairReason, type DrawContext, type PreviewTeam, type ResolvedScenario } from './swissScenario'
import { WORLDS_2026_SWISS_RULES, applySwissWinner, swissBestOf } from './worlds2026Swiss'
import { shuffled, worldsRandom } from './worldsSimulation'

/** Chance that team `a` beats team `b` in one series. */
export type SeriesWinChance = (a: string, b: string, bestOf: 1 | 3) => number

export type SwissOdds = {
  trials: number
  /** Share of trials in which each team reached three wins. */
  advance: ReadonlyMap<string, number>
  /** Share of trials in which at least one team of each group reached three wins, in the order of the groups. */
  anyAdvance: number[]
}

/**
 * Plays the rest of a Swiss scenario `trials` times. Decided matches and drawn rounds stay as they are. Open
 * matches are won by chance from `winChance`. Each later round is drawn by Riot's procedure, `drawByRulebook`.
 */
export function simulateSwissOdds(teams: readonly PreviewTeam[], scenario: ResolvedScenario, winChance: SeriesWinChance,
  groups: ReadonlyArray<readonly string[]>, { trials, seed }: { trials: number; seed: number }): SwissOdds {
  const random = worldsRandom(seed)
  const advanced = new Map(teams.map((team) => [team.id, 0]))
  const anyAdvance = groups.map(() => 0)
  const index = new Map(teams.map((team, position) => [team.id, position]))
  const open = scenario.rounds.at(-1)?.matches.filter((match) => !match.winnerId) ?? []
  const roundOne = scenario.rounds.length ? null : roundOneDraws(drawContext(1, teams, scenario.standings))
  for (let trial = 0; trial < trials; trial++) {
    const standings = scenario.standings.map((row) => ({ ...row, opponents: [...row.opponents] }))
    const play = (pair: [string, string], bestOf: 1 | 3) =>
      applySwissWinner(standings, pair, random() < winChance(pair[0], pair[1], bestOf) ? pair[0] : pair[1])
    for (const match of open) play(match.teamIds, match.bestOf)
    if (roundOne) for (const pairs of roundOne) for (const pair of pairs[Math.floor(random() * pairs.length)]) play(pair, 1)
    for (let round = scenario.rounds.length + (roundOne ? 2 : 1); round <= SWISS_ROUND_SIZES.length; round++) {
      const context = drawContext(round, teams, standings)
      // The look-ahead asks about the same pairs many times in one draw. 1 is legal, 2 is not, 0 is not checked yet.
      const known = new Uint8Array(teams.length ** 2)
      const legal = (a: string, b: string) => {
        const key = index.get(a)! * teams.length + index.get(b)!
        known[key] ||= pairReason(a, b, context) ? 2 : 1
        return known[key] === 1
      }
      const pairs = context.buckets.flatMap((bucket) => {
        const drawn = drawByRulebook(shuffled(bucket.teamIds, random), legal)
        if (!drawn) throw new Error(`Round ${round} has no legal draw.`)
        return drawn
      })
      const byId = new Map(standings.map((row) => [row.id, row]))
      for (const pair of pairs) play(pair, swissBestOf(byId.get(pair[0])!))
    }
    const through = new Set(standings.filter((row) => row.status === 'advanced').map((row) => row.id))
    for (const id of through) advanced.set(id, advanced.get(id)! + 1)
    for (const [index, group] of groups.entries()) if (group.some((id) => through.has(id))) anyAdvance[index]++
  }
  return {
    trials,
    advance: new Map([...advanced].map(([id, count]) => [id, count / trials])),
    anyAdvance: anyAdvance.map((count) => count / trials),
  }
}

/**
 * Riot's draw procedure, rules 4.3.2.2 to 4.3.3.2. Teams come out of the pot in `order`. Each team takes the first
 * open slot, with matches filled in order. If that slot breaks a draw restriction, or leaves no legal way to finish
 * the draw, the team moves to the next open slot. Returns null when no legal draw exists.
 */
export function drawByRulebook(order: readonly string[], legal: (a: string, b: string) => boolean): [string, string][] | null {
  const matches: string[][] = Array.from({ length: order.length / 2 }, () => [])
  for (const [index, team] of order.entries()) {
    const rest = order.slice(index + 1)
    const slot = matches.find((match) => match.length < 2 && (!match.length || legal(match[0], team)) && canFinish(
      matches.flatMap((other) => other === match ? (match.length ? [] : [team]) : other.length === 1 ? [other[0]] : []), rest, legal))
    if (!slot) return null
    slot.push(team)
  }
  return matches as [string, string][]
}

/**
 * Every outcome of the Round 1 draw, one list for each half: Pool 1 teams, then their opponents from Pool 4, and
 * Pool 2 teams, then their opponents from Pool 3 (rule 4.3.2.2). The halves share no restriction, and each pot
 * order is equally likely, so one random entry from each list is one random official draw.
 */
function roundOneDraws(context: DrawContext): [string, string][][][] {
  const legal = (a: string, b: string) => !pairReason(a, b, context)
  const pool = (index: number) => [...context.teams.values()].filter((team) =>
    (WORLDS_2026_SWISS_RULES.pools[index] as readonly string[]).includes(team.seed ?? '')).map((team) => team.id)
  return [[0, 3], [1, 2]].map(([home, away]) => permutations(pool(home)).flatMap((homes) => permutations(pool(away)).map((aways) => {
    const drawn = drawByRulebook([...homes, ...aways], legal)
    if (!drawn) throw new Error('Round 1 has no legal draw.')
    return drawn
  })))
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]]
  return values.flatMap((value, index) => permutations(values.filter((_, other) => other !== index)).map((rest) => [value, ...rest]))
}

/** Whether the teams left in the pot can fill every open slot: first the matches with one team, then empty ones. */
function canFinish(waiting: readonly string[], pot: readonly string[], legal: (a: string, b: string) => boolean): boolean {
  const used = pot.map(() => false)
  const fill = (next: number): boolean => {
    if (next < waiting.length) {
      for (let index = 0; index < pot.length; index++) {
        if (used[index] || !legal(waiting[next], pot[index])) continue
        used[index] = true
        if (fill(next + 1)) return true
        used[index] = false
      }
      return false
    }
    const first = used.indexOf(false)
    if (first < 0) return true
    used[first] = true
    for (let index = first + 1; index < pot.length; index++) {
      if (used[index] || !legal(pot[first], pot[index])) continue
      used[index] = true
      if (fill(next)) return true
      used[index] = false
    }
    used[first] = false
    return false
  }
  return fill(0)
}
