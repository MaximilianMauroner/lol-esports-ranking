import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { compareCodeUnits } from '../src/lib/codeUnitOrder.mjs'

/**
 * Fixed CPU workload that measures how fast the current runner executes the
 * kind of work the incremental refresh does. It uses only Node built-ins and
 * seeded data, so ranking code changes cannot change its duration.
 *
 * Its mix follows the refresh CPU profile: object-graph construction with a
 * large live heap, keyed Map updates and float math, canonical JSON, SHA-256,
 * and gzip. Single-threaded JavaScript of this kind tracks the gate's
 * GitHub runner variance; I/O-bound work does not.
 */
export function runCalibrationWorkload() {
  let seed = 0x2545f491
  const random = () => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
    return seed / 0x1_0000_0000
  }
  const teamCount = 400
  const records = Array.from({ length: 60_000 }, (_, index) => ({
    id: `series-${index}`,
    date: `20${10 + (index % 16)}-${String(1 + (index % 12)).padStart(2, '0')}-${String(1 + (index % 28)).padStart(2, '0')}`,
    teams: [`team-${Math.floor(random() * teamCount)}`, `team-${Math.floor(random() * teamCount)}`],
    games: Array.from({ length: 1 + (index % 5) }, () => ({
      winner: random() < 0.5 ? 0 : 1,
      durationSeconds: Math.round(1_200 + random() * 1_800),
      players: Array.from({ length: 10 }, (_, slot) => ({ id: `player-${Math.floor(random() * 4_000)}`, slot, kills: Math.floor(random() * 12) })),
    })),
  }))

  const ratings = new Map<string, { rating: number; history: number[] }>()
  for (const record of records) {
    const [left, right] = record.teams.map((team) => {
      let entry = ratings.get(team)
      if (!entry) ratings.set(team, entry = { rating: 1_500, history: [] })
      return entry
    })
    for (const game of record.games) {
      const expected = 1 / (1 + 10 ** ((right!.rating - left!.rating) / 400))
      const delta = 24 * ((game.winner === 0 ? 1 : 0) - expected)
      left!.rating += delta
      right!.rating -= delta
      left!.history.push(left!.rating)
      right!.history.push(right!.rating)
    }
  }

  const hashes: string[] = []
  for (let start = 0; start < records.length; start += 2_000) {
    const page = canonicalJson(records.slice(start, start + 2_000))
    hashes.push(createHash('sha256').update(page).digest('hex'))
    hashes.push(createHash('sha256').update(gzipSync(page, { level: 6 })).digest('hex'))
  }
  const ranked = [...ratings].sort((left, right) => right[1].rating - left[1].rating || compareCodeUnits(left[0], right[0]))
  return createHash('sha256').update(hashes.join('')).update(canonicalJson(ranked.slice(0, 20))).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
