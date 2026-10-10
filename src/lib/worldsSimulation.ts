import { compareCodeUnits } from './codeUnitOrder.mjs'
import { forecastTournamentSeries, type ForecastBasis, type ForecastReady } from './tournamentForecast'
import { forecastWorlds2026PlayIn, replayWorlds2026PlayIn, WORLDS_2026_PLAY_IN_RULES, type Worlds2026PlayInInput } from './worlds2026PlayIn'
import { forecastWorlds2026Knockout, replayWorlds2026Knockout, WORLDS_2026_KNOCKOUT_RULES, type Worlds2026KnockoutInput } from './worlds2026Knockout'
import { applySwissWinner, replayWorlds2026Swiss, validWorldsTime, WORLDS_2026_SWISS_RULES, worldsUnavailable,
  type SwissReplay, type Worlds2026SwissEntrant, type Worlds2026SwissInput, type WorldsUnavailable } from './worlds2026Swiss'
import type { SwissTeamStanding } from './worldsObservedRules'

export type Worlds2026EventInput = {
  format: 'worlds-2026'
  directEntrants: Worlds2026SwissEntrant[]
  playIn: Worlds2026PlayInInput
  swiss: Worlds2026SwissInput | null
  knockout: Worlds2026KnockoutInput | null
}
export const WORLD_STAGES = ['swiss', 'knockout', 'semifinal', 'final', 'champion'] as const
export type WorldStage = typeof WORLD_STAGES[number]
export const WORLD_FINISHES = ['19', '18', '17', '15–16', '12–14', '9–11', '5–8', '3–4', '2', '1'] as const
export type WorldFinish = typeof WORLD_FINISHES[number]
export type WorldOddsRow = {
  id: string; seed: string; state: string
  stages: Record<WorldStage, number | null>
  /** Derived from observations, never from sampled zeros/ones. */
  deterministicStages: Record<WorldStage, boolean>
  finishes: Record<WorldFinish, number | null>
}
export type WorldsReport = {
  pinnedState: Worlds2026EventInput
  rules: { ids: string[]; source: string; version: string; checkedAt: string; sourceSha256: string }
  eventId: string; stateVersion: string; asOf: string; currentStage: string
  teams: WorldOddsRow[]
  matches: Array<{ label: string; teamIds: [string, string]; winnerId: string | null }>
  unavailable: string[]
  method: 'observed-state' | 'exact-enumeration' | 'seeded-monte-carlo'
  engineVersion: 'worlds-2026-composition-v1'
  trials: number; seed: number; elapsedMs: number
  /** Unrounded counts, present only for sampled stages. */
  counts: Array<{ id: string; stages: Record<WorldStage, number>; finishes: Record<WorldFinish, number> }>
  model: { snapshotId: string; version: string; configHash: string; dataAsOf: string; publishedAt: string; identityRevision: string;
    parameters: ForecastBasis['model']['parameters']; ratingScale: ForecastBasis['model']['ratingScale']; dataMode: ForecastBasis['dataMode'] } | null
  hypotheticalMatchups: ForecastReady[]
  assumptions: string[]
}
export type SimulationOptions = { trials: number; seed: number }
export type SimulationHooks = { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void; yield?: () => Promise<void> }
export type WorldsSimulationResult = { status: 'supported'; report: WorldsReport } | WorldsUnavailable

/** A full field is retained even when a later stage's random procedure is unavailable. */
export async function runWorldsSimulation(input: Worlds2026EventInput, basis: ForecastBasis | null,
  options: SimulationOptions, hooks: SimulationHooks = {}): Promise<WorldsSimulationResult> {
  const started = performance.now()
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff
    || !Number.isInteger(options.trials) || options.trials < 1 || options.trials > 10_000) {
    return worldsUnavailable('invalid-state', 'A uint32 seed and 1–10,000 trials are required. Larger refinements are not enabled.')
  }
  hooks.signal?.throwIfAborted()
  input = structuredClone(input)
  basis = basis ? structuredClone(basis) : null
  const playIn = replayWorlds2026PlayIn(input.playIn)
  if (playIn.status === 'unsupported') return playIn
  const contextError = validateEventContext(input)
  if (contextError) return contextError
  const report = initialReport(input, basis, options)
  for (const team of playIn.teams) {
    const row = report.teams.find((row) => row.id === team.id)!
    row.state = team.status === 'active' ? 'Play-In active' : team.status === 'qualified' ? 'Reached Swiss' : `Eliminated · ${team.finish}th`
    if (team.status === 'eliminated') setFinish(row, String(team.finish) as WorldFinish)
    if (team.status === 'qualified') { row.stages.swiss = 1; row.deterministicStages.swiss = true }
  }
  for (const definition of WORLDS_2026_PLAY_IN_RULES.matches) {
    const match = playIn.resolvedMatches[definition.id] ?? playIn.readyMatches.find((row) => row.slot === definition.id)
    if (match) report.matches.push({ label: `Play-In ${definition.id}`, teamIds: match.teamIds, winnerId: 'winnerId' in match ? match.winnerId : null })
  }
  if (!playIn.resolvedMatches.r4) {
    if (basis) {
      const forecast = forecastWorlds2026PlayIn(input.playIn, basis)
      if (forecast.status === 'supported') {
        report.method = 'exact-enumeration'
        report.hypotheticalMatchups.push(...forecast.hypotheticalMatchups)
        for (const odds of forecast.teams) {
          const row = report.teams.find((row) => row.id === odds.id)!
          row.stages.swiss = odds.advanceToSwissProbability
          row.finishes['17'] = odds.finish17Probability; row.finishes['18'] = odds.finish18Probability; row.finishes['19'] = odds.finish19Probability
        }
      } else report.unavailable.push(`Play-In forecast: ${forecast.detail}`)
    } else report.unavailable.push('Play-In forecast: the frozen model snapshot is unavailable.')
  }
  if (!input.swiss) {
    if (playIn.resolvedMatches.r4) report.currentStage = 'Swiss draw pending'
    report.unavailable.push(WORLDS_2026_SWISS_RULES.drawUnavailable)
    return finishReport(report, started)
  }
  const swiss = replayWorlds2026Swiss(input.swiss)
  if (swiss.status === 'unsupported') return swiss
  const handoffError = validateSwissHandoff(input, playIn.resolvedMatches.r4?.winnerId)
  if (handoffError) return handoffError
  report.currentStage = swiss.completedRounds === 5 ? 'Knockout draw pending' : `Swiss · round ${swiss.currentRound || 1}`
  applyObservedSwiss(report, swiss)
  report.matches.push(...swiss.matches.map((match) => ({ label: `Swiss R${match.round} · Bo${match.bestOf}`, teamIds: match.teamIds, winnerId: match.winnerId })))
  if (input.knockout) {
    const error = validateKnockoutHandoff(input.knockout, swiss)
    if (error) return error
    const replay = replayWorlds2026Knockout(input.knockout)
    if (replay.status === 'unsupported') return replay
    report.currentStage = replay.resolvedMatches[6] ? 'Completed' : 'Knockout'
    for (const [slot, definition] of WORLDS_2026_KNOCKOUT_RULES.matches.entries()) {
      const match = replay.resolvedMatches[slot] ?? replay.readyMatches.find((row) => row.slot === slot)
      if (match) report.matches.push({ label: `${definition.stage} ${definition.stage === 'quarterfinal' ? slot + 1 : definition.stage === 'semifinal' ? slot - 3 : 1} · Bo5`, teamIds: match.teamIds, winnerId: 'winnerId' in match ? match.winnerId : null })
    }
    for (const state of replay.teams) {
      const row = report.teams.find((row) => row.id === state.id)!
      row.state = state.eliminatedAt ? `Eliminated · ${state.eliminatedAt}` : `Reached ${state.reached}`
      if (state.reached !== 'quarterfinal') row.stages.semifinal = 1
      if (state.reached === 'final' || state.reached === 'champion') row.stages.final = 1
      if (state.reached !== 'quarterfinal') row.deterministicStages.semifinal = true
      if (state.reached === 'final' || state.reached === 'champion') row.deterministicStages.final = true
      if (state.eliminatedAt) setFinish(row, state.eliminatedAt === 'quarterfinal' ? '5–8' : state.eliminatedAt === 'semifinal' ? '3–4' : '2')
      if (state.reached === 'champion') setFinish(row, '1')
    }
    if (!basis && !replay.resolvedMatches[6]) report.unavailable.push('Knockout forecast: the frozen model snapshot is unavailable.')
    else {
      const forecast = forecastWorlds2026Knockout(input.knockout, basis)
      if (forecast.status === 'unsupported') report.unavailable.push(`Knockout forecast: ${forecast.detail}`)
      else {
        report.method = 'exact-enumeration'
        report.hypotheticalMatchups.push(...forecast.hypotheticalMatchups)
        for (const odds of forecast.teams) {
          const row = report.teams.find((row) => row.id === odds.id)!
          row.stages = { swiss: 1, knockout: 1, semifinal: odds.reachSemifinalProbability, final: odds.reachFinalProbability, champion: odds.championProbability }
          row.finishes = zeroFinishes()
          Object.assign(row.finishes, { '5–8': odds.finish5To8Probability, '3–4': odds.finish3To4Probability, '2': odds.runnerUpProbability, '1': odds.championProbability })
        }
      }
    }
    return finishReport(report, started)
  }
  if (swiss.currentRound !== 5) {
    report.unavailable.push(WORLDS_2026_SWISS_RULES.drawUnavailable)
    return finishReport(report, started)
  }
  if (!basis) { report.unavailable.push('Remaining-stage forecast: the frozen model snapshot is unavailable.'); return finishReport(report, started) }
  if (!validWorldsTime(basis.ratingDataAsOf) || !validWorldsTime(basis.ratingPublishedAt)
    || Date.parse(basis.ratingDataAsOf) > Date.parse(basis.ratingPublishedAt) || Date.parse(basis.ratingPublishedAt) > Date.parse(input.playIn.asOf)) {
    report.unavailable.push('Remaining-stage forecast: snapshot cutoff must precede publication, which must precede event information cutoff.')
    return finishReport(report, started)
  }
  const sampled = await sampleSwissToKnockout(report, swiss, basis, options, hooks)
  if (sampled) report.unavailable.push(sampled.detail)
  return finishReport(report, started)
}

function initialReport(input: Worlds2026EventInput, basis: ForecastBasis | null, options: SimulationOptions): WorldsReport {
  const field = [...input.directEntrants, ...input.playIn.entrants]
  return {
    pinnedState: structuredClone(input),
    rules: { ids: [input.playIn.rulesId, WORLDS_2026_SWISS_RULES.id, WORLDS_2026_KNOCKOUT_RULES.id],
      source: WORLDS_2026_SWISS_RULES.source, version: WORLDS_2026_SWISS_RULES.sourceVersion, checkedAt: WORLDS_2026_SWISS_RULES.checkedAt,
      sourceSha256: WORLDS_2026_SWISS_RULES.sourceSha256 },
    eventId: input.playIn.eventId, stateVersion: input.playIn.stateVersion, asOf: input.playIn.asOf,
    currentStage: 'Play-In', teams: field.map(({ id, seed }) => ({ id, seed, state: seed === 'PLAYIN' ? 'Reached Swiss' : 'Awaiting Swiss',
      stages: { swiss: input.directEntrants.some((team) => team.id === id) ? 1 : null, knockout: null, semifinal: null, final: null, champion: null },
      deterministicStages: { swiss: input.directEntrants.some((team) => team.id === id), knockout: false, semifinal: false, final: false, champion: false },
      finishes: Object.fromEntries(WORLD_FINISHES.map((finish) => [finish, null])) as Record<WorldFinish, number | null> })),
    matches: [], unavailable: [], method: 'observed-state', engineVersion: 'worlds-2026-composition-v1',
    trials: 0, seed: options.seed, elapsedMs: 0, counts: [], hypotheticalMatchups: [],
    model: basis ? { snapshotId: basis.snapshotId, version: basis.model.version, configHash: basis.model.configHash,
      dataAsOf: basis.ratingDataAsOf, publishedAt: basis.ratingPublishedAt, identityRevision: basis.identityMap.revision,
      parameters: structuredClone(basis.model.parameters), ratingScale: structuredClone(basis.model.ratingScale), dataMode: basis.dataMode } : null,
    assumptions: [
      'Conditional on the supplied observations. Evidence tags are caller assertions, not official-source certification.',
      'Frozen Power, uncertainty, roster and model/config; independent neutral games from the existing shared probability provider. Side/pick and draft choices are not modeled.',
      'Monte Carlo sampling error measures finite trials only. It is separate from model uncertainty and calibration. A sampled zero does not prove elimination.',
      'Future Swiss draws are unavailable until the sequential displacement/look-ahead and waiver procedure is established. No uniform legal Swiss matching is used.',
    ],
  }
}
function validateEventContext(input: Worlds2026EventInput): WorldsUnavailable | null {
  const seeds: readonly string[] = WORLDS_2026_SWISS_RULES.pools.flat().filter((seed) => seed !== 'PLAYIN')
  const allIds = [...input.directEntrants, ...input.playIn.entrants].map((team) => team.id)
  if (input.directEntrants.length !== 15 || new Set(allIds).size !== 19 || new Set(input.directEntrants.map((team) => team.seed)).size !== 15
    || input.directEntrants.some((team) => !team.id.trim() || !seeds.includes(team.seed) || team.region !== team.seed.replace(/\d+$/, ''))) {
    return worldsUnavailable('invalid-state', 'The full nineteen-team field requires all fifteen direct seeds and four distinct Play-In entrants, including LCP and CBLOL.')
  }
  for (const stage of [input.swiss, input.knockout]) {
    if (stage && (stage.eventId !== input.playIn.eventId || stage.stateVersion !== input.playIn.stateVersion || stage.asOf !== input.playIn.asOf)) {
      return worldsUnavailable('invalid-state', 'Every stage must use the same event, state revision and information cutoff.')
    }
  }
  if (input.knockout && !input.swiss) return worldsUnavailable('invalid-state', 'Knockout handoff requires the observed Swiss state.')
  const results = [...input.playIn.results, ...(input.swiss?.rounds.flatMap((round) => round.results) ?? []), ...(input.knockout?.results ?? [])]
  if (new Set(results.map((result) => result.matchId)).size !== results.length) return worldsUnavailable('invalid-state', 'A match ID cannot be reused across event stages.')
  for (const definition of WORLDS_2026_PLAY_IN_RULES.matches) {
    const observed = input.playIn.results.find((result) => result.slot === definition.id)
    for (const reference of [definition.home, definition.away]) {
      if (!observed || !('match' in reference)) continue
      const prior = input.playIn.results.find((result) => result.slot === reference.match)
      if (prior && Date.parse(prior.observedAt) > Date.parse(observed.observedAt)) return worldsUnavailable('invalid-state', 'A Play-In result cannot precede its upstream result.')
    }
  }
  const lastSwissResult = Math.max(-Infinity, ...(input.swiss?.rounds.flatMap((round) => round.results.map((result) => Date.parse(result.observedAt))) ?? []))
  if (input.knockout?.results.some((result) => Date.parse(result.observedAt) < lastSwissResult)) return worldsUnavailable('invalid-state', 'Knockout results cannot precede completed Swiss qualification.')
  return null
}
function validateSwissHandoff(input: Worlds2026EventInput, winnerId: string | undefined): WorldsUnavailable | null {
  const swiss = input.swiss!
  const qualifier = swiss.entrants.find((team) => team.seed === 'PLAYIN')
  if (!winnerId || qualifier?.id !== winnerId || qualifier.region !== input.playIn.entrants.find((team) => team.id === winnerId)!.seed.replace(/\d+$/, '')
    || input.directEntrants.some((team) => !swiss.entrants.some((other) => other.id === team.id && other.seed === team.seed && other.region === team.region))) {
    return worldsUnavailable('invalid-state', 'Swiss must contain the confirmed Play-In winner and all fifteen unchanged direct seeds.')
  }
  const finalAt = input.playIn.results.find((result) => result.slot === 'r4')!.observedAt
  if (swiss.rounds.some((round) => Date.parse(round.drawnAt) < Date.parse(finalAt))) return worldsUnavailable('invalid-state', 'Swiss draws cannot precede the Play-In final.')
  return null
}
function validateKnockoutHandoff(knockout: Worlds2026KnockoutInput, swiss: SwissReplay): WorldsUnavailable | null {
  if (swiss.completedRounds !== 5 || swiss.standings.filter((team) => team.status === 'advanced').length !== 8
    || knockout.qualifiers.some((team) => !swiss.standings.some((row) => row.id === team.id && row.wins === 3 && row.losses === team.swissLosses))) {
    return worldsUnavailable('invalid-state', 'Knockout qualifiers and records must equal the eight completed Swiss qualifiers.')
  }
  return null
}
function applyObservedSwiss(report: WorldsReport, swiss: SwissReplay) {
  for (const team of swiss.standings) {
    const row = report.teams.find((row) => row.id === team.id)!
    row.stages.swiss = 1
    row.deterministicStages.swiss = true
    row.state = `${team.status === 'advanced' ? 'Reached knockout' : team.status === 'eliminated' ? 'Eliminated in Swiss' : 'Swiss active'} · ${team.wins}–${team.losses}`
    if (team.status === 'advanced') { row.stages.knockout = 1; row.deterministicStages.knockout = true }
    if (team.status === 'eliminated') setFinish(row, team.wins === 0 ? '15–16' : team.wins === 1 ? '12–14' : '9–11')
  }
}
function setFinish(row: WorldOddsRow, finish: WorldFinish) {
  row.finishes = zeroFinishes(); row.finishes[finish] = 1
  const reached = finish === '1' ? 5 : finish === '2' ? 4 : finish === '3–4' ? 3 : finish === '5–8' ? 2 : ['9–11', '12–14', '15–16'].includes(finish) ? 1 : 0
  row.stages = Object.fromEntries(WORLD_STAGES.map((stage, index) => [stage, index < reached ? 1 : 0])) as WorldOddsRow['stages']
  row.deterministicStages = { swiss: true, knockout: true, semifinal: true, final: true, champion: true }
}
function zeroFinishes(): Record<WorldFinish, number> {
  return { '19': 0, '18': 0, '17': 0, '15–16': 0, '12–14': 0, '9–11': 0, '5–8': 0, '3–4': 0, '2': 0, '1': 0 }
}
function finishReport(report: WorldsReport, started: number): WorldsSimulationResult {
  report.elapsedMs = performance.now() - started
  return { status: 'supported', report }
}

/** Mulberry32. The stream is local to this run and never alters the frozen basis. */
export function worldsRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = Math.imul(state ^ state >>> 15, 1 | state)
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}
function shuffled<T>(values: T[], random: () => number) {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[result[index], result[other]] = [result[other], result[index]]
  }
  return result
}
/** §4.3.4: unrestricted random opponents, then random remaining pairings. Halves never re-seed. */
export function drawWorlds2026Knockout(standings: SwissTeamStanding[], random: () => number): string[] {
  const advanced = standings.filter((team) => team.status === 'advanced').sort((a, b) => compareCodeUnits(a.id, b.id))
  const unbeaten = advanced.filter((team) => team.losses === 0)
  const late = shuffled(advanced.filter((team) => team.losses === 2), random)
  const rest = shuffled([...advanced.filter((team) => team.losses === 1), late[2]], random)
  return [unbeaten[0].id, late[0].id, rest[0].id, rest[1].id, unbeaten[1].id, late[1].id, rest[2].id, rest[3].id]
}
async function sampleSwissToKnockout(report: WorldsReport, swiss: SwissReplay, basis: ForecastBasis, options: SimulationOptions, hooks: SimulationHooks): Promise<WorldsUnavailable | null> {
  const random = worldsRandom(options.seed)
  const cache = new Map<string, ForecastReady>()
  function probability(pair: [string, string], bestOf: 3 | 5): number | WorldsUnavailable {
    const key = JSON.stringify([pair, bestOf])
    let forecast = cache.get(key)
    if (!forecast) {
      const result = forecastTournamentSeries({ id: `hypothetical:${key}`, eventId: report.eventId, startTime: null, stage: 'Worlds simulation',
        bestOf, status: 'upcoming', sourceState: 'unstarted', vodUrls: [],
        teams: pair.map((id) => ({ id, name: null, code: null, gameWins: null, outcome: null })) }, basis)
      if (result.status === 'unavailable') return worldsUnavailable('model-unavailable', `${pair.join(' vs ')}: ${result.detail}`)
      const values = [result.homeSeriesWinProbability, result.awaySeriesWinProbability, result.homeGameWinProbability, result.awayGameWinProbability]
      if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
        || Math.abs(values[0] + values[1] - 1) > 0.0002 || Math.abs(values[2] + values[3] - 1) > 0.0002) return worldsUnavailable('model-unavailable', 'The shared provider returned invalid or noncomplementary probabilities.')
      forecast = result; cache.set(key, forecast)
    }
    return forecast.homeSeriesWinProbability
  }
  // Validate every reachable remaining team before producing aggregate probabilities.
  const candidates = swiss.standings.filter((team) => team.status !== 'eliminated').map((team) => team.id)
  for (const [index, id] of candidates.entries()) {
    for (const other of candidates.slice(index + 1)) {
      const checked = probability([id, other], 5)
      if (typeof checked !== 'number') return checked
    }
  }
  for (const match of swiss.readyMatches) {
    const checked = probability(match.teamIds, 3)
    if (typeof checked !== 'number') return checked
  }
  const counts = report.teams.map((row) => ({ id: row.id, stages: { swiss: 0, knockout: 0, semifinal: 0, final: 0, champion: 0 }, finishes: zeroFinishes() }))
  const byId = new Map(counts.map((row) => [row.id, row]))
  let yieldedAt = performance.now()
  for (let trial = 0; trial < options.trials; trial++) {
    hooks.signal?.throwIfAborted()
    const standings = structuredClone(swiss.standings)
    for (const match of swiss.readyMatches) {
      const p = probability(match.teamIds, 3)
      if (typeof p !== 'number') return p
      applySwissWinner(standings, match.teamIds, match.teamIds[random() < p ? 0 : 1])
    }
    for (const row of report.teams) {
      const count = byId.get(row.id)!
      if (row.stages.swiss === 1) count.stages.swiss++
      for (const finish of WORLD_FINISHES) if (row.finishes[finish] === 1) count.finishes[finish]++
    }
    for (const team of standings) {
      const count = byId.get(team.id)!
      if (team.status === 'advanced') count.stages.knockout++
      else if (team.wins === 2 && report.teams.find((row) => row.id === team.id)!.finishes['9–11'] !== 1) count.finishes['9–11']++
    }
    const slots = drawWorlds2026Knockout(standings, random)
    const winners: string[] = []
    for (const [index, definition] of WORLDS_2026_KNOCKOUT_RULES.matches.entries()) {
      const pair: [string, string] = [definition.stage === 'quarterfinal' ? slots[definition.upstream[0]] : winners[definition.upstream[0]],
        definition.stage === 'quarterfinal' ? slots[definition.upstream[1]] : winners[definition.upstream[1]]]
      const p = probability(pair, 5)
      if (typeof p !== 'number') return p
      const winner = random() < p ? 0 : 1
      winners[index] = pair[winner]
      const nextStage = definition.stage === 'quarterfinal' ? 'semifinal' : definition.stage === 'semifinal' ? 'final' : 'champion'
      const finish = definition.stage === 'quarterfinal' ? '5–8' : definition.stage === 'semifinal' ? '3–4' : '2'
      byId.get(pair[winner])!.stages[nextStage]++
      byId.get(pair[1 - winner])!.finishes[finish]++
    }
    byId.get(winners[6])!.finishes['1']++
    if (performance.now() - yieldedAt > 16 || trial === options.trials - 1) {
      hooks.onProgress?.(trial + 1, options.trials)
      await (hooks.yield?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 0)))
      hooks.signal?.throwIfAborted()
      yieldedAt = performance.now()
    }
  }
  report.method = 'seeded-monte-carlo'; report.trials = options.trials; report.counts = counts
  report.hypotheticalMatchups.push(...cache.values())
  for (const row of report.teams) {
    const count = byId.get(row.id)!
    for (const stage of WORLD_STAGES) row.stages[stage] = count.stages[stage] / options.trials
    for (const finish of WORLD_FINISHES) row.finishes[finish] = count.finishes[finish] / options.trials
  }
  return null
}

/** Wilson 95% interval remains nonzero at a sampled zero. It is not model confidence. */
export function worldsSamplingInterval(count: number, trials: number): [number, number] {
  const z = 1.96; const p = count / trials; const divisor = 1 + z * z / trials
  const center = (p + z * z / (2 * trials)) / divisor
  const radius = z * Math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials)) / divisor
  return [Math.max(0, center - radius), Math.min(1, center + radius)]
}
