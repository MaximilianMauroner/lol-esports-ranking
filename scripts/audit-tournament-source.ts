import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { competitionForLeague, normalizeTournamentFeed, type TournamentCompetition } from '../src/lib/tournamentFeed.ts'

const competitions: TournamentCompetition[] = ['lcs', 'lec', 'lpl', 'lck', 'worlds', 'msi', 'first-stand']
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function rows(value: unknown) { return Array.isArray(value) ? value.filter(record) : [] }
function text(value: unknown) { return typeof value === 'string' ? value : '' }

/** Audit retained captures only. This command makes no provider or bucket request. */
export async function auditTournamentSource(paths: string[], teamDirectoryPath?: string) {
  const captures = []
  const participants = new Map<string, { names: Set<string>; competitions: Set<string>; captures: Set<string> }>()
  for (const path of paths) {
    const bytes = await readFile(path)
    const raw: unknown = JSON.parse(bytes.toString('utf8'))
    if (!record(raw) || !Array.isArray(raw.events)) throw new Error('Expected a retained LoL Esports schedule capture')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const details = new Map(rows(raw.eventDetails).flatMap((entry) => record(entry.event) ? [[text(entry.id), entry.event] as const] : []))
    const observations = rows(raw.events).map((event) => ({ event,
      detail: details.get(record(event.match) ? text(event.match.id) : text(event.id)) }))
    const feed = normalizeTournamentFeed({ observations, fetchedAt: text(raw.fetchedAt), coverageStart: text(raw.start),
      coverageEnd: text(raw.end), coverageComplete: false,
      warnings: ['Retained ranking reference capture; live-feed coverage and source-use approval are not certified.'] })
    const families = Object.fromEntries(competitions.map((competition) => {
      const events = feed.events.filter((event) => event.competition === competition)
      const series = events.flatMap((event) => event.series)
      return [competition, { events: events.length, series: series.length,
        states: Object.fromEntries([...new Set(series.map((match) => match.status))].map((status) => [status, series.filter((match) => match.status === status).length])),
        missingTeamIds: series.filter((match) => match.teams.length !== 2 || match.teams.some((team) => !team.id)).length,
        unsupportedFormat: series.filter((match) => ![1, 3, 5].includes(match.bestOf ?? 0)).length }]
    }))
    for (const observation of observations) {
      const competition = competitionForLeague(observation.event.league)
      if (!competition || !observation.detail || !record(observation.detail.match)) continue
      for (const team of rows(observation.detail.match.teams)) {
        const id = text(team.id)
        if (!id) continue
        const prior = participants.get(id) ?? { names: new Set<string>(), competitions: new Set<string>(), captures: new Set<string>() }
        prior.names.add(text(team.name)); prior.competitions.add(competition); prior.captures.add(hash)
        participants.set(id, prior)
      }
    }
    captures.push({ name: path.split('/').at(-1), sha256: hash, bytes: bytes.length, fetchedAt: raw.fetchedAt,
      requestedWindow: { start: raw.start, end: raw.end }, scheduleRows: rows(raw.events).length,
      details: details.size, families, warnings: raw.warnings })
  }
  const directoryBytes = teamDirectoryPath ? await readFile(teamDirectoryPath) : null
  const directory: unknown = directoryBytes ? JSON.parse(directoryBytes.toString('utf8')) : null
  const content = record(directory) && record(directory.content) ? directory.content : directory
  const rankingTeams = record(content) ? rows(content.teams) : []
  return { sourceApproval: 'unverified', liveAcceptance: false, captures,
    rankingDirectory: directoryBytes ? { sha256: createHash('sha256').update(directoryBytes).digest('hex'), bytes: directoryBytes.length } : null,
    mappingReviewCandidates: [...participants].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([sourceTeamId, evidence]) => ({
      sourceTeamId, sourceNames: [...evidence.names].sort(), competitions: [...evidence.competitions].sort(), captureDigests: [...evidence.captures].sort(),
      // Names produce review candidates only. They never create an accepted ID crosswalk.
      exactNameCandidates: rankingTeams.filter((team) => evidence.names.has(text(team.name))).map((team) => ({ teamId: team.teamId, name: team.name, region: team.region })),
      reviewed: false,
    })),
    requestBudget: { collectorMaximumLogicalRequests: 1 + 2 * 8 + 120, maximumAttemptsPerRequest: 3,
      maximumRequestsPer60SecondPollDay: 137 * 1440, maximumAttemptsPer60SecondPollDay: 137 * 3 * 1440,
      note: 'Upper bounds from the current collector. No timer or approved cadence is active. They are not an upstream SLA.' },
    remainingEvidence: ['approved polling/public redistribution terms', 'representative seven-family discovery and corrections',
      'measured request rate and 429 behavior', 'source-to-viewer latency/freshness/recovery', 'reviewed ID crosswalk', 'real ledger and independent delivery before play'],
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [output, directory, ...captures] = process.argv.slice(2)
  if (!output || !directory || !captures.length) throw new Error('Usage: audit-tournament-source.ts <output.json> <team-directory.json|-> <captured-schedules...>')
  await writeFile(output, JSON.stringify(await auditTournamentSource(captures, directory === '-' ? undefined : directory), null, 2) + '\n')
}
