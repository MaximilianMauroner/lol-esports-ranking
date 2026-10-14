import { compareCodeUnits } from './codeUnitOrder.mjs'
import type { TournamentSeries } from './tournamentFeed'

/**
 * Infers how an event is played from its schedule alone. Leaguepedia names
 * stages ("Round 2", "Finals") but never says upper or lower bracket, so the
 * side of each series comes from its teams' records inside the stage.
 */
export type BracketSide = 'upper' | 'lower' | 'final'
export type BracketMatch = {
  series: TournamentSeries
  column: number
  side: BracketSide
  /** IDs of earlier series in the same lane whose winner plays here. */
  feeders: string[]
}
export type EliminationSection = { kind: 'elimination'; columns: string[]; matches: BracketMatch[]; hasLower: boolean }

export type WinLoss = { wins: number; losses: number }
export type SwissPool = { label: string; series: TournamentSeries[]; pending: number }
export type SwissRound = { title: string; series: TournamentSeries[]; pools: SwissPool[]; unpaired: TournamentSeries[] }
export type Standing = WinLoss & { team: string; status: 'advanced' | 'eliminated' | null }
export type SwissSection = { kind: 'swiss'; rounds: SwissRound[]; standings: Standing[]; winsToAdvance: number | null }

export type GroupSection = { kind: 'groups'; groups: Array<{ standings: Standing[]; series: TournamentSeries[] }> }
export type TournamentSection = EliminationSection | SwissSection | GroupSection

type Tab = { title: string; kind: 'round' | 'group' | 'knockout'; series: TournamentSeries[] }

export function tournamentSections(series: readonly TournamentSeries[]): TournamentSection[] {
  const tabs = orderedTabs(series)
  const swiss = swissSpan(tabs)
  const sections: TournamentSection[] = []
  const addRun = (run: Tab[]) => {
    for (let start = 0; start < run.length;) {
      const grouped = run[start]!.kind === 'group'
      let end = start
      while (end < run.length && (run[end]!.kind === 'group') === grouped) end += 1
      const part = run.slice(start, end)
      sections.push(grouped ? groupSection(part) : eliminationSection(part))
      start = end
    }
  }
  if (!swiss) addRun(tabs)
  else {
    addRun(tabs.slice(0, swiss.start))
    const later = tabs.slice(swiss.end).flatMap((tab) => tab.series)
    sections.push(swissSection(tabs.slice(swiss.start, swiss.end), later))
    addRun(tabs.slice(swiss.end))
  }
  return sections
}

/** 0 or 1 for a confirmed winner, otherwise null. */
export function seriesWinner(series: TournamentSeries): 0 | 1 | null {
  if (series.status !== 'completed') return null
  const [first, second] = series.teams
  if (first?.outcome === 'win' || second?.outcome === 'loss') return 0
  if (second?.outcome === 'win' || first?.outcome === 'loss') return 1
  if (first?.gameWins == null || second?.gameWins == null || first.gameWins === second.gameWins) return null
  return first.gameWins > second.gameWins ? 0 : 1
}

export function teamKey(team: TournamentSeries['teams'][number] | undefined) {
  return team?.id ?? team?.name ?? null
}

function orderedTabs(series: readonly TournamentSeries[]): Tab[] {
  const byTitle = new Map<string, TournamentSeries[]>()
  for (const entry of series) {
    const title = entry.stage ?? 'Matches'
    byTitle.set(title, [...(byTitle.get(title) ?? []), entry])
  }
  return [...byTitle].map(([title, entries]) => ({ title, kind: tabKind(title), series: entries.sort(compareInTab) }))
    .sort((a, b) => compareCodeUnits(earliest(a), earliest(b)) || compareCodeUnits(a.title, b.title))
}

function tabKind(title: string): Tab['kind'] {
  if (/^round \d+$/i.test(title)) return 'round'
  if (/\b(?:day|week|group|round robin)\b/i.test(title)) return 'group'
  return 'knockout'
}

/** Leaguepedia match IDs end in the series' position inside its tab, which follows the bracket drawing: upper bracket first. */
function positionInTab(series: TournamentSeries) {
  const match = /_(\d+)$/.exec(series.id)
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY
}
function compareInTab(a: TournamentSeries, b: TournamentSeries) {
  return positionInTab(a) - positionInTab(b) || compareChronological(a, b)
}
function compareChronological(a: TournamentSeries, b: TournamentSeries) {
  return compareCodeUnits(a.startTime ?? '￿', b.startTime ?? '￿') || compareCodeUnits(a.id, b.id)
}
function earliest(tab: Tab) {
  return tab.series.reduce((min, entry) => entry.startTime && entry.startTime < min ? entry.startTime : min, '￿')
}

/** Records each team carried into every series, replayed in play order. */
function recordsBeforeSeries(series: readonly TournamentSeries[]) {
  const records = new Map<string, WinLoss>()
  const before = new Map<string, Array<WinLoss | null>>()
  for (const entry of [...series].sort(compareChronological)) {
    const keys = entry.teams.map(teamKey)
    before.set(entry.id, keys.map((key) => key ? { ...records.get(key) ?? { wins: 0, losses: 0 } } : null))
    const winner = seriesWinner(entry)
    if (winner === null) continue
    keys.forEach((key, index) => {
      if (!key) return
      const record = records.get(key) ?? { wins: 0, losses: 0 }
      if (index === winner) record.wins += 1
      else record.losses += 1
      records.set(key, record)
    })
  }
  return { records, before }
}

function eliminationSection(tabs: Tab[]): EliminationSection {
  const all = tabs.flatMap((tab) => tab.series)
  const { before } = recordsBeforeSeries(all)
  const knownTeams = new Set(tabs[0]?.series.flatMap((entry) => entry.teams.map(teamKey)).filter(Boolean))
  // Teams waiting for their next series in each lane; only used when teams are still TBD.
  let upperWaiting = knownTeams.size || 2 * (tabs[0]?.series.length ?? 0)
  let lowerWaiting = 0
  const matches: BracketMatch[] = []
  tabs.forEach((tab, column) => {
    const lastColumn = column === tabs.length - 1
    const known = tab.series.map((entry) => sideFromRecords(before.get(entry.id) ?? [], lastColumn && tab.series.length === 1))
    let upperNext = 0
    let lowerNext = 0
    tab.series.forEach((entry, index) => {
      let side = known[index]
      if (!side) {
        if (known.slice(index + 1).includes('upper')) side = 'upper'
        else if (known.slice(0, index).includes('lower')) side = 'lower'
        else if (upperWaiting >= 2) side = 'upper'
        // Only numbered rounds mix lanes; a named round such as "Quarterfinals" is one stage.
        else if (tab.kind === 'round' && lowerWaiting >= 2) side = 'lower'
        else side = lastColumn && tab.series.length === 1 && matches.some((match) => match.side === 'lower') ? 'final' : 'upper'
      }
      if (side === 'upper') {
        upperWaiting = Math.max(0, upperWaiting - 2); upperNext += 1; lowerWaiting += 1
      } else if (side === 'lower') {
        lowerWaiting = Math.max(0, lowerWaiting - 2); lowerNext += 1
      }
      matches.push({ series: entry, column, side, feeders: [] })
    })
    upperWaiting += upperNext
    lowerWaiting += lowerNext
  })
  const hasLower = matches.some((match) => match.side === 'lower')
  if (!hasLower) for (const match of matches) match.side = 'upper'
  linkFeeders(matches)
  return { kind: 'elimination', columns: tabs.map((tab) => tab.title), matches, hasLower }
}

/** Unbeaten teams play in the upper bracket; a lone unbeaten-versus-once-beaten series at the end is the grand final. */
function sideFromRecords(records: Array<WinLoss | null>, canBeFinal: boolean): BracketSide | null {
  const losses = records.filter((record): record is WinLoss => record !== null).map((record) => record.losses)
  if (!losses.length) return null
  const unbeaten = losses.some((value) => value === 0)
  const beaten = losses.some((value) => value > 0)
  if (unbeaten && beaten) return canBeFinal ? 'final' : 'upper'
  return beaten ? 'lower' : 'upper'
}

/**
 * Connects each series to the earlier series in its lane that produced its teams.
 * Known winners are followed; TBD slots use the standard drawing when a round
 * halves (pairs feed one series) or keeps its size (one series feeds one).
 */
function linkFeeders(matches: BracketMatch[]) {
  const lane = (side: BracketSide) => {
    const columns = new Map<number, BracketMatch[]>()
    for (const match of matches) if (match.side === side) columns.set(match.column, [...(columns.get(match.column) ?? []), match])
    return [...columns.entries()].sort(([a], [b]) => a - b).map(([, entries]) => entries)
  }
  const lanes = { upper: lane('upper'), lower: lane('lower') }
  for (const columns of Object.values(lanes)) {
    columns.forEach((current, index) => {
      const previous = columns[index - 1]
      if (!previous) return
      for (const match of current) {
        for (const team of match.series.teams.map(teamKey)) {
          const feeder = previous.concat(...columns.slice(0, index - 1)).find((candidate) => team && seriesWinnerKey(candidate.series) === team)
          if (feeder) match.feeders.push(feeder.series.id)
        }
      }
      // A decided earlier series whose winner is not here went elsewhere, so it cannot fill a TBD slot.
      const claimed = new Set(current.flatMap((match) => match.feeders))
      const open = (candidate: BracketMatch) => !claimed.has(candidate.series.id) && seriesWinner(candidate.series) === null
      const perMatch = previous.length === current.length ? 1 : previous.length === 2 * current.length ? 2 : 0
      current.forEach((match, position) => {
        const tbdSlots = match.series.teams.filter((team) => !teamKey(team)).length
        const wanted = Math.min(tbdSlots, perMatch - match.feeders.length)
        const fill = previous.slice(position * perMatch, (position + 1) * perMatch).filter(open).slice(0, Math.max(0, wanted))
        match.feeders.push(...fill.map((candidate) => candidate.series.id))
      })
    })
  }
  for (const final of matches.filter((match) => match.side === 'final')) {
    for (const last of [lanes.upper.at(-1), lanes.lower.at(-1)]) {
      const feeder = last?.find((match) => final.series.teams.some((team) => teamKey(team) && seriesWinnerKey(match.series) === teamKey(team)))
        ?? (last?.length === 1 ? last[0] : undefined)
      if (feeder) final.feeders.push(feeder.series.id)
    }
  }
}
function seriesWinnerKey(series: TournamentSeries) {
  const winner = seriesWinner(series)
  return winner === null ? null : teamKey(series.teams[winner])
}

/**
 * A Swiss stage pairs every team in its first two rounds, and keeps playing
 * teams with two losses, or plays its third round at full size. Double
 * elimination does neither.
 */
function swissSpan(tabs: Tab[]) {
  const rounds = tabs.map((tab, index) => ({ tab, index })).filter(({ tab }) => tab.kind === 'round')
  const [first, second, third] = rounds.map(({ tab }) => tab.series)
  if (!first || !second || first.length < 4 || first.length !== second.length || !distinctTeams(first) || !distinctTeams(second)) return null
  const start = rounds[0]!.index
  const end = rounds.at(-1)!.index + 1
  const spanSeries = tabs.slice(start, end).flatMap((tab) => tab.series)
  const { before } = recordsBeforeSeries(spanSeries)
  const playsTwiceBeaten = [...before.values()].some((records) => records.some((record) => record && record.losses >= 2))
  return third?.length === first.length || playsTwiceBeaten ? { start, end } : null
}
function distinctTeams(series: TournamentSeries[]) {
  const keys = series.flatMap((entry) => entry.teams.map(teamKey)).filter(Boolean)
  return new Set(keys).size === keys.length
}

function swissSection(tabs: Tab[], laterSeries: TournamentSeries[]): SwissSection {
  const all = tabs.flatMap((tab) => tab.series)
  const { records, before } = recordsBeforeSeries(all)
  const roundSizes = tabs.every((tab) => tab.kind === 'round') ? tabs.map((tab) => tab.series.length) : null
  const winsToAdvance = roundSizes ? standardSwissTarget(roundSizes) : null
  const expected = winsToAdvance ? expectedSwissPools(2 * roundSizes![0]!, winsToAdvance, roundSizes!.length) : null
  const rounds = tabs.map((tab, index) => {
    const pools = new Map<string, SwissPool>()
    for (const [label, count] of expected?.[index] ?? []) pools.set(label, { label, series: [], pending: count })
    const unpaired: TournamentSeries[] = []
    for (const entry of tab.series) {
      const labels = [...new Set((before.get(entry.id) ?? []).filter((record): record is WinLoss => record !== null).map(recordLabel))]
      if (!labels.length) {
        if (!expected) unpaired.push(entry)
        continue
      }
      const label = labels.join(' vs ')
      const pool = pools.get(label) ?? { label, series: [], pending: 0 }
      pool.series.push(entry)
      pool.pending = Math.max(0, pool.pending - 1)
      pools.set(label, pool)
    }
    return { title: tab.title, series: tab.series, pools: [...pools.values()].sort(comparePools), unpaired }
  })
  const advancing = new Set(laterSeries.flatMap((entry) => entry.teams.map(teamKey)).filter(Boolean))
  const finished = all.every((entry) => seriesWinner(entry) !== null || entry.status === 'cancelled')
  const standings = [...records].map(([team, record]): Standing => ({
    team, ...record,
    status: winsToAdvance !== null
      ? record.wins >= winsToAdvance ? 'advanced' : record.losses >= winsToAdvance ? 'eliminated' : null
      : advancing.has(team) ? 'advanced' : finished && advancing.size ? 'eliminated' : null,
  }))
  for (const team of all.flatMap((entry) => entry.teams.map(teamKey))) {
    if (team && !records.has(team)) standings.push({ team, wins: 0, losses: 0, status: null })
  }
  return { kind: 'swiss', rounds, standings: standings.sort(compareStandings), winsToAdvance }
}

/** The win target whose pool arithmetic reproduces every round's size, if any. */
function standardSwissTarget(roundSizes: number[]) {
  for (let target = 2; target <= 5; target += 1) {
    const pools = expectedSwissPools(2 * roundSizes[0]!, target, roundSizes.length)
    if (pools.every((round, index) => [...round.values()].reduce((sum, count) => sum + count, 0) === roundSizes[index])
      && roundSizes.length === 2 * target - 1) return target
  }
  return null
}
function expectedSwissPools(teams: number, target: number, rounds: number) {
  let counts = new Map<string, number>([['0-0', teams]])
  const result: Array<Map<string, number>> = []
  for (let round = 0; round < rounds; round += 1) {
    const pools = new Map<string, number>()
    const next = new Map<string, number>()
    for (const [key, count] of counts) {
      const [wins, losses] = key.split('-').map(Number) as [number, number]
      if (wins >= target || losses >= target) continue
      pools.set(recordLabel({ wins, losses }), Math.floor(count / 2))
      next.set(`${wins + 1}-${losses}`, (next.get(`${wins + 1}-${losses}`) ?? 0) + Math.floor(count / 2))
      next.set(`${wins}-${losses + 1}`, (next.get(`${wins}-${losses + 1}`) ?? 0) + Math.floor(count / 2))
    }
    result.push(pools)
    counts = next
  }
  return result
}
function recordLabel(record: WinLoss) { return `${record.wins}–${record.losses}` }
function comparePools(a: SwissPool, b: SwissPool) {
  const [aw, al] = a.label.split(/[–\s]/).map(Number) as [number, number]
  const [bw, bl] = b.label.split(/[–\s]/).map(Number) as [number, number]
  return (bw - bl) - (aw - al) || bw - aw || compareCodeUnits(a.label, b.label)
}
function compareStandings(a: Standing, b: Standing) {
  const rank = (standing: Standing) => standing.status === 'advanced' ? 0 : standing.status === 'eliminated' ? 2 : 1
  return rank(a) - rank(b) || (b.wins - b.losses) - (a.wins - a.losses) || b.wins - a.wins || compareCodeUnits(a.team, b.team)
}

/** Teams that only play each other form a group; the source does not name groups. */
function groupSection(tabs: Tab[]): GroupSection {
  const series = tabs.flatMap((tab) => tab.series).sort(compareChronological)
  const parent = new Map<string, string>()
  const find = (key: string): string => {
    const root = parent.get(key) ?? key
    if (root === key) return key
    const resolved = find(root)
    parent.set(key, resolved)
    return resolved
  }
  for (const entry of series) {
    const [first, second] = entry.teams.map(teamKey)
    if (first && !parent.has(first)) parent.set(first, first)
    if (second && !parent.has(second)) parent.set(second, second)
    if (first && second) parent.set(find(first), find(second))
  }
  const groups = new Map<string, TournamentSeries[]>()
  for (const entry of series) {
    const key = entry.teams.map(teamKey).find(Boolean)
    const root = key ? find(key) : ''
    groups.set(root, [...(groups.get(root) ?? []), entry])
  }
  return {
    kind: 'groups',
    groups: [...groups.values()].map((entries) => {
      const { records } = recordsBeforeSeries(entries)
      const teams = new Set(entries.flatMap((entry) => entry.teams.map(teamKey)).filter((key): key is string => key !== null))
      const standings = [...teams].map((team): Standing => ({ team, ...records.get(team) ?? { wins: 0, losses: 0 }, status: null }))
      return { standings: standings.sort(compareStandings), series: entries }
    }),
  }
}
