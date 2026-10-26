import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PIN = 'c1a1efa0036186ea24c5677d61c1a2d7cbc29a0b0700fedacae6b3286632d89b'
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const boundaries = ['2025-04-01', '2025-07-01', '2025-10-01', '2026-01-01']
export const developmentFolds = [['2025-04-01', '2025-07-01'], ['2025-07-01', '2025-10-01'], ['2025-10-01', '2026-01-01']] as const
const period = (date: string) => boundaries.filter(boundary => date >= boundary).length
const day = (date: string) => Date.parse(`${date}T00:00:00.000Z`) / 86400000

type Game = {
  id: string; seriesId: string; date: string; datetimeUtc: string; event: string
  bestOf: 1 | 3 | 5; gameNumber: number; teamA: string; teamB: string; winnerId: string
  state: 'completed' | 'ongoing' | 'unknown'; winsA: number; winsB: number
}
export type OutcomeSeries = {
  id: string; event: string; date: string; teamA: string; teamB: string
  bestOf: 1 | 3 | 5; outcome: 0 | 1; gameIds: string[]
}
export type Candidate = { id: string; k: number; halfLife: number | null; yearRetention: number }
export const candidates: readonly Candidate[] = [
  { id: 'elo-k32', k: 32, halfLife: null, yearRetention: 1 },
  { id: 'elo-k16', k: 16, halfLife: null, yearRetention: 1 },
  { id: 'elo-k64', k: 64, halfLife: null, yearRetention: 1 },
  { id: 'elo-k32-half90', k: 32, halfLife: 90, yearRetention: 1 },
  { id: 'elo-k32-half180', k: 32, halfLife: 180, yearRetention: 1 },
  { id: 'elo-k32-year50', k: 32, halfLife: null, yearRetention: .5 },
]

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.length) throw new Error('Expected nonempty string')
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Expected nonnegative integer')
  return value
}
function game(value: unknown): Game {
  const row = object(value)
  const date = string(row.date)
  const datetimeUtc = string(row.datetimeUtc)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(day(date)) ||
      new Date(day(date) * 86400000).toISOString().slice(0, 10) !== date ||
      !Number.isFinite(Date.parse(datetimeUtc)) || !datetimeUtc.endsWith('Z') ||
      new Date(datetimeUtc).toISOString().slice(0, 10) !== date) throw new Error('Invalid UTC date')
  const bestOf = integer(row.bestOf)
  if (bestOf !== 1 && bestOf !== 3 && bestOf !== 5) throw new Error('Unsupported bestOf')
  const state = row.seriesState
  if (state !== 'completed' && state !== 'ongoing' && state !== 'unknown') throw new Error('Invalid series state')
  const teamA = string(object(row.teamA).id), teamB = string(object(row.teamB).id)
  const winnerId = string(row.winnerId)
  if (teamA === teamB || (winnerId !== teamA && winnerId !== teamB)) throw new Error('Invalid team/winner join')
  return { id: string(row.id), seriesId: string(row.seriesId), date, datetimeUtc,
    event: string(row.event), bestOf, gameNumber: integer(row.gameNumber), teamA, teamB,
    winnerId, state, winsA: integer(row.seriesWinsA), winsB: integer(row.seriesWinsB) }
}

export function parseOutcomeRows(rows: unknown[]) {
  const groups = new Map<string, Game[]>()
  const ids = new Set<string>()
  const eventPeriods = new Map<string, Set<number>>()
  for (const row of rows) {
    const g = game(row)
    if (ids.has(g.id)) throw new Error(`Duplicate game ${g.id}`)
    ids.add(g.id)
    const group = groups.get(g.seriesId) ?? []
    group.push(g)
    groups.set(g.seriesId, group)
    const periods = eventPeriods.get(g.event) ?? new Set<number>()
    periods.add(period(g.date))
    eventPeriods.set(g.event, periods)
  }
  const series: OutcomeSeries[] = []
  const excluded: { id: string; reason: string }[] = []
  seriesLoop: for (const [id, games] of groups) {
    games.sort((a, b) => a.gameNumber - b.gameNumber)
    const first = games[0]
    const pair = [first.teamA, first.teamB].sort(compare).join('\0')
    if (games.some(g => [g.teamA, g.teamB].sort(compare).join('\0') !== pair ||
      g.event !== first.event || g.bestOf !== first.bestOf || g.state !== first.state)) {
      throw new Error(`Conflicting series identity ${id}`)
    }
    if (first.state !== 'completed') { excluded.push({ id, reason: first.state }); continue }
    const needed = (first.bestOf + 1) / 2
    let winsA = 0, winsB = 0
    for (const [index, g] of games.entries()) {
      if (g.gameNumber !== index + 1 || winsA >= needed || winsB >= needed ||
        (index > 0 && Date.parse(g.datetimeUtc) < Date.parse(games[index - 1].datetimeUtc))) {
        excluded.push({ id, reason: 'invalid-game-sequence' }); continue seriesLoop
      }
      if (g.winnerId === first.teamA) winsA++; else winsB++
      const a = g.teamA === first.teamA ? winsA : winsB
      const b = g.teamA === first.teamA ? winsB : winsA
      if (g.winsA !== a || g.winsB !== b) { excluded.push({ id, reason: 'invalid-cumulative-score' }); continue seriesLoop }
    }
    if (Math.max(winsA, winsB) !== needed || Math.min(winsA, winsB) >= needed) { excluded.push({ id, reason: 'nonterminal-completed' }); continue }
    if (games.some(g => g.date !== first.date)) { excluded.push({ id, reason: 'cross-utc-date' }); continue }
    if (eventPeriods.get(first.event)!.size > 1) { excluded.push({ id, reason: 'boundary-event' }); continue }
    if (first.date < '2025-01-01' || first.date >= '2027-01-01') { excluded.push({ id, reason: 'outside-years' }); continue }
    series.push({ id, event: first.event, date: first.date, teamA: first.teamA, teamB: first.teamB,
      bestOf: first.bestOf, outcome: winsA === needed ? 1 : 0, gameIds: games.map(g => g.id) })
  }
  series.sort((a, b) => compare(a.date, b.date) || compare(a.id, b.id))
  excluded.sort((a, b) => compare(a.id, b.id))
  return { series, excluded, gameCount: ids.size, seriesCount: groups.size }
}

export function loadOutcomes(root: string) {
  const pins: { path: string; sha256: string }[] = []
  function read(path: string): Record<string, unknown> {
    const bytes = readFileSync(resolve(root, path))
    pins.push({ path, sha256: hash(bytes) })
    return object(JSON.parse(bytes.toString('utf8')))
  }
  const catalog = read('matches/all.json')
  if (catalog.artifactKind !== 'match-history-catalog' || !Array.isArray(catalog.pages)) throw new Error('Invalid catalog')
  const rows: unknown[] = []
  const paths = new Set<string>()
  for (const entry of catalog.pages) {
    const descriptor = object(entry)
    const url = string(descriptor.url)
    if (!/^\/data\/matches\/pages\/all-\d+\.json(?:\?[^#]*)?$/.test(url)) throw new Error('Invalid page URL')
    const path = url.split('?')[0].slice('/data/'.length)
    if (paths.has(path)) throw new Error('Duplicate catalog page')
    paths.add(path)
    const page = read(path)
    if (page.artifactKind !== 'match-history-page' || !Array.isArray(page.matches) ||
      page.page !== descriptor.page || page.gameCount !== page.matches.length ||
      page.gameCount !== descriptor.gameCount) throw new Error('Invalid page identity/count')
    rows.push(...page.matches)
  }
  pins.sort((a, b) => compare(a.path, b.path))
  const inventory = createHash('sha256')
  for (const pin of pins) inventory.update(pin.path).update('\0').update(Buffer.from(pin.sha256, 'hex'))
  const inventoryHash = inventory.digest('hex')
  if (inventoryHash !== PIN) throw new Error(`Input pin mismatch ${inventoryHash}`)
  const parsed = parseOutcomeRows(rows)
  if (catalog.gameCount !== parsed.gameCount || catalog.seriesCount !== parsed.seriesCount) throw new Error('Catalog count mismatch')
  return { ...parsed, pins, inventoryHash }
}

export function replayOutcomes(series: OutcomeSeries[], candidate: Candidate) {
  if (!Number.isFinite(candidate.k) || candidate.k <= 0 || !Number.isFinite(candidate.yearRetention) ||
    candidate.yearRetention < 0 || candidate.yearRetention > 1 ||
    (candidate.halfLife !== null && (!Number.isFinite(candidate.halfLife) || candidate.halfLife <= 0))) throw new Error('Invalid candidate')
  const ratings = new Map<string, { value: number; date: string }>()
  const ordered = [...series].sort((a, b) => compare(a.date, b.date) || compare(a.id, b.id))
  const history = new Map<string, number>()
  const predictions: (OutcomeSeries & { probability: number; priorSeriesA: number; priorSeriesB: number })[] = []
  for (let start = 0; start < ordered.length;) {
    let end = start + 1
    while (end < ordered.length && ordered[end].date === ordered[start].date) end++
    const date = ordered[start].date
    const priors = new Map<string, number>(), changes = new Map<string, number>()
    const rating = (team: string) => {
      if (priors.has(team)) return priors.get(team)!
      const previous = ratings.get(team)
      const elapsed = previous ? day(date) - day(previous.date) : 0
      const years = previous ? Number(date.slice(0, 4)) - Number(previous.date.slice(0, 4)) : 0
      const retention = (candidate.halfLife === null ? 1 : 2 ** (-elapsed / candidate.halfLife)) * candidate.yearRetention ** years
      const value = 1500 + ((previous?.value ?? 1500) - 1500) * retention
      priors.set(team, value)
      return value
    }
    for (const s of ordered.slice(start, end)) {
      const p = 1 / (1 + 10 ** ((rating(s.teamB) - rating(s.teamA)) / 400))
      const probability = s.bestOf === 1 ? p : s.bestOf === 3 ? p * p * (3 - 2 * p) : p ** 3 * (10 - 15 * p + 6 * p * p)
      predictions.push({ ...s, probability, priorSeriesA: history.get(s.teamA) ?? 0, priorSeriesB: history.get(s.teamB) ?? 0 })
      const delta = candidate.k * (s.outcome - probability)
      changes.set(s.teamA, (changes.get(s.teamA) ?? 0) + delta)
      changes.set(s.teamB, (changes.get(s.teamB) ?? 0) - delta)
    }
    for (const [team, delta] of changes) ratings.set(team, { value: priors.get(team)! + delta, date })
    for (const s of ordered.slice(start, end)) {
      history.set(s.teamA, (history.get(s.teamA) ?? 0) + 1)
      history.set(s.teamB, (history.get(s.teamB) ?? 0) + 1)
    }
    start = end
  }
  return predictions
}

type Prediction = ReturnType<typeof replayOutcomes>[number]
function losses(p: number, outcome: number) {
  const bounded = Math.max(1e-15, Math.min(1 - 1e-15, p))
  return { brier: (p - outcome) ** 2, logLoss: -Math.log(outcome === 1 ? bounded : 1 - bounded) }
}
function scores(rows: Prediction[]) {
  if (!rows.length) throw new Error('Empty scoring cohort')
  const total = rows.reduce((sum, row) => {
    const loss = losses(row.probability, row.outcome)
    return { brier: sum.brier + loss.brier, logLoss: sum.logLoss + loss.logLoss }
  }, { brier: 0, logLoss: 0 })
  return { count: rows.length, events: new Set(rows.map(row => row.event)).size,
    firstDate: rows[0].date, lastDate: rows.at(-1)!.date,
    coldStartCount: rows.filter(row => row.priorSeriesA === 0 || row.priorSeriesB === 0).length,
    brier: total.brier / rows.length, logLoss: total.logLoss / rows.length }
}
export function pairedComparison(selected: Prediction[], control: Prediction[]) {
  if (selected.length !== control.length || !selected.length) throw new Error('Invalid paired cohort')
  const clusters = new Map<string, { count: number; brier: number; logLoss: number }>()
  for (const [index, row] of selected.entries()) {
    const base = control[index]
    if (row.id !== base.id || row.event !== base.event || row.date !== base.date || row.teamA !== base.teamA ||
      row.teamB !== base.teamB || row.bestOf !== base.bestOf || row.outcome !== base.outcome) throw new Error('Paired identity mismatch')
    const a = losses(row.probability, row.outcome), b = losses(base.probability, base.outcome)
    const total = clusters.get(row.event) ?? { count: 0, brier: 0, logLoss: 0 }
    total.count++; total.brier += a.brier - b.brier; total.logLoss += a.logLoss - b.logLoss
    clusters.set(row.event, total)
  }
  const groups = [...clusters.entries()].sort(([a], [b]) => compare(a, b)).map(([, value]) => value)
  let seed = 20261026
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const draws = { brier: [] as number[], logLoss: [] as number[] }
  for (let draw = 0; draw < 2000; draw++) {
    let count = 0, brier = 0, logLoss = 0
    for (let index = 0; index < groups.length; index++) {
      const sample = groups[Math.floor(random() * groups.length)]
      count += sample.count; brier += sample.brier; logLoss += sample.logLoss
    }
    draws.brier.push(brier / count); draws.logLoss.push(logLoss / count)
  }
  const interval = (values: number[]) => { values.sort((a, b) => a - b); return [values[49], values[1949]] }
  const a = scores(selected), b = scores(control)
  return { selected: a, control: b, delta: { brier: a.brier - b.brier, logLoss: a.logLoss - b.logLoss },
    eventBootstrap: { seed: 20261026, draws: 2000, percentile95: { brier: interval(draws.brier), logLoss: interval(draws.logLoss) } } }
}

export function evaluateOutcomes(series: OutcomeSeries[]) {
  const developmentSeries = series.filter(s => s.date >= '2025-01-01' && s.date < '2026-01-01')
  const development = candidates.map(candidate => {
    const rows = replayOutcomes(developmentSeries, candidate).filter(s => s.date >= '2025-04-01')
    return { candidate, ...scores(rows), folds: developmentFolds.map(([start, end]) =>
      ({ start, end, ...scores(rows.filter(s => s.date >= start && s.date < end)) })) }
  })
  const selected = development.reduce((best, next) => next.logLoss < best.logLoss ||
    (next.logLoss === best.logLoss && next.brier < best.brier) ? next : best).candidate
  const selectedRows = replayOutcomes(series, selected).filter(s => s.date >= '2026-01-01' && s.date < '2027-01-01')
  const controlRows = replayOutcomes(series, candidates[0]).filter(s => s.date >= '2026-01-01' && s.date < '2027-01-01')
  return { development, selected, heldOutComputation: pairedComparison(selectedRows, controlRows),
    neutral: scores(selectedRows.map(row => ({ ...row, probability: .5 }))),
    warmupIds: developmentSeries.filter(s => s.date < '2025-04-01').map(s => s.id),
    developmentIds: developmentSeries.filter(s => s.date >= '2025-04-01').map(s => s.id),
    predictions: selectedRows.map((row, index) => ({ ...row, controlProbability: controlRows[index].probability })) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, protocolPath, output] = process.argv.slice(2)
  if (!root || !protocolPath || !output || process.argv.length !== 5) throw new Error('Usage: retrospective-outcomes.ts DATA_ROOT PROTOCOL_PATH OUTPUT_JSON')
  const input = loadOutcomes(root)
  const result = { schemaVersion: 1, classification: 'exploratory historical-limited latest-corrected-prior-replay',
    limitations: ['2026 is a held-out computation split, not an untouched research holdout',
      'No historical availability proof, production model replay, bookmaker comparison or trading qualification',
      'Latest public identities and outcomes can contain later corrections; team IDs do not track roster changes',
      'Event bootstrap does not remove repeat-search bias or dependence between events'],
    provenance: { inventoryHash: input.inventoryHash, pins: input.pins, protocolHash: hash(readFileSync(protocolPath)),
      runnerHash: hash(readFileSync(fileURLToPath(import.meta.url))), configHash: hash(JSON.stringify({ candidates, developmentFolds, boundaries })) },
    input: { games: input.gameCount, series: input.seriesCount, eligibleSeries: input.series.length, excluded: input.excluded },
    ...evaluateOutcomes(input.series) }
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ output, selected: result.selected, heldOutComputation: result.heldOutComputation, neutral: result.neutral }, null, 2))
}
