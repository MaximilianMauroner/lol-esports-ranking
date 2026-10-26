import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { predictPregameSeries, replayPregameSeriesBatch, replaySimpleEloSeriesBatch, predictSimpleEloSeries, simpleEloPolicy } from '../../src/domains/rankings/forecast.ts'
import type { CalibrationFit, ForecastTransform, PregameSeriesRequest, PregameForecastMetadata } from '../../src/domains/rankings/forecast.ts'
import { deriveTournamentInstances } from '../../src/domains/rankings/evidence.ts'
import { transparentGprModelMetadata } from '../../src/domains/rankings/build.ts'
import { importRankingSourceData } from './source-input.ts'
import { rankingSourceProvenance } from './source-provenance.ts'
import { manifestWithResolvedFiles } from '../local-data-manifest.js'

export type ForecastCandidate = {
  modelKind?: 'ranking' | 'simple-elo'
  candidateId: string
  parentCandidateId: string | null
  transform: ForecastTransform
  calibrationFit: CalibrationFit | null
}

export type ForecastRequestFile = {
  evidenceMode: 'synthetic' | 'retrospective' | 'prospective'
  availability: 'verified' | 'historical-limited'
  observations: Array<{ gameId: string; observedAt: number; resultAvailableAt: number | null }>
  sourceFiles?: Array<{ path: string; sha256: string; observedAt: number }>
  requests: PregameSeriesRequest[]
}

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

export async function exportPregameSeries(manifestPath: string, requestsPath: string, candidatePath: string, outputPath: string) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const [manifestBytes, requestsBytes, candidateBytes] = await Promise.all([manifestPath, requestsPath, candidatePath].map(path => readFile(resolve(path))))
  const manifest = manifestWithResolvedFiles(JSON.parse(manifestBytes.toString()), dirname(resolve(manifestPath)))
  const requests: ForecastRequestFile = JSON.parse(requestsBytes.toString())
  const candidate: ForecastCandidate = JSON.parse(candidateBytes.toString())
  if (candidate.modelKind !== undefined && !['ranking', 'simple-elo'].includes(candidate.modelKind)) throw new Error('Unsupported forecast model kind')
  const simpleElo = candidate.modelKind === 'simple-elo'
  if (simpleElo && (candidate.candidateId !== simpleEloPolicy.candidateId || candidate.parentCandidateId !== null
    || candidate.calibrationFit !== null || candidate.transform?.temperature !== 1 || candidate.transform?.dependence !== 0
    || candidate.transform?.calibrationOrder !== 'game-before-series')) throw new Error('Simple Elo requires fixed identity and no learned transforms')
  if (!simpleElo && candidate.candidateId === simpleEloPolicy.candidateId) throw new Error('Reserved simple Elo candidate identity')
  if (!['synthetic', 'retrospective', 'prospective'].includes(requests.evidenceMode)
    || !['verified', 'historical-limited'].includes(requests.availability)
    || !Array.isArray(requests.requests) || !requests.requests.length || !Array.isArray(requests.observations)
    || new Set(requests.requests.map(row => row.seriesId)).size !== requests.requests.length
    || new Set(requests.observations.map(row => row.gameId)).size !== requests.observations.length) throw new Error('Invalid forecast requests or duplicate identities')
  if (requests.evidenceMode === 'prospective' && requests.availability !== 'verified') throw new Error('Prospective export needs capture evidence')
  const rawPaths = [...new Set(Object.values(manifest.files as Record<string, string[]>).flat())].sort()
  if (!rawPaths.length) throw new Error('No retained raw inputs')
  const inputDigests = await Promise.all([...rawPaths, resolve(requestsPath), resolve(candidatePath)].map(async path => ({ path, sha256: sha256(await readFile(path)) })))
  const gitRoot = process.env.RANKING_REPOSITORY_ROOT ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim()
  const { sourceDigests, sourceHash } = await rankingSourceProvenance(root, gitRoot)
  const dependencyLockHash = sha256(await readFile(resolve(root, 'pnpm-lock.yaml')))
  const modelCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRoot, encoding: 'utf8' }).trim()
  const observations = new Map(requests.observations.map(row => [row.gameId, row]))
  for (const row of observations.values()) {
    if (!Number.isSafeInteger(row.observedAt) || row.observedAt < 0
      || (row.resultAvailableAt !== null && (!Number.isSafeInteger(row.resultAvailableAt)
        || row.resultAvailableAt < 0 || row.resultAvailableAt > row.observedAt))) throw new Error('Invalid game observation')
  }
  const captures = new Map<string, number>()
  if (requests.availability === 'verified') {
    const explicit = new Map((requests.sourceFiles ?? []).map(row => [resolve(dirname(resolve(manifestPath)), row.path), row]))
    if (explicit.size !== (requests.sourceFiles ?? []).length) throw new Error('Duplicate source file capture')
    for (const path of rawPaths) {
      const capture = explicit.get(path)
      const json = (manifest.files.leaguepediaJson ?? []).includes(path) || (manifest.files.lolEsportsJson ?? []).includes(path)
      const fetchedAt = json ? Date.parse(JSON.parse(await readFile(path, 'utf8')).fetchedAt) : NaN
      if (capture && (!Number.isSafeInteger(capture.observedAt) || capture.observedAt < 0
        || capture.sha256 !== inputDigests.find(input => input.path === path)?.sha256)) throw new Error(`Invalid source file capture: ${path}`)
      const observedAt = Math.max(capture?.observedAt ?? -Infinity, Number.isFinite(fetchedAt) ? fetchedAt : -Infinity)
      if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error(`Missing source file capture: ${path}`)
      captures.set(path, observedAt)
    }
  }
  const configurationHash = sha256(JSON.stringify({ candidate, model: simpleElo ? simpleEloPolicy : transparentGprModelMetadata }))
  const inputManifestHash = sha256(manifestBytes)
  const startedAt = Date.now()
  const states: unknown[] = []
  const groups = new Map<string, { indexes: number[]; paths: string[]; gameIds: Set<string>; cutoffDate: string }>()
  for (const [index, request] of requests.requests.entries()) {
    const verified = requests.availability === 'verified'
    const paths = rawPaths.filter(path => !verified || captures.get(path)! <= request.asOf)
    const gameIds = new Set(requests.observations.filter(row => !verified
      || (row.observedAt <= request.asOf && row.resultAvailableAt !== null && row.resultAvailableAt <= request.asOf)).map(row => row.gameId))
    const cutoffDate = new Date(request.asOf).toISOString().slice(0, 10)
    const key = verified ? JSON.stringify([paths, [...gameIds].sort(), cutoffDate]) : 'historical-limited'
    const group = groups.get(key)
    if (group) group.indexes.push(index)
    else groups.set(key, { indexes: [index], paths, gameIds, cutoffDate })
  }
  const eloResults: ReturnType<typeof replaySimpleEloSeriesBatch>['results'] = []
  const batch: ReturnType<typeof replayPregameSeriesBatch> = { results: [], replayCount: 0, replayedGames: 0 }
  for (const group of groups.values()) {
    const sourceObservedAt = new Set(group.paths.flatMap(path => captures.has(path) ? [captures.get(path)!] : []))
    const verified = requests.availability === 'verified'
    const source = await importRankingSourceData({
      oracleCsvPaths: (manifest.files.oracleCsv ?? []).filter((path: string) => group.paths.includes(path)),
      leaguepediaJsonPaths: (manifest.files.leaguepediaJson ?? []).filter((path: string) => group.paths.includes(path)),
      lolEsportsJsonPaths: (manifest.files.lolEsportsJson ?? []).filter((path: string) => group.paths.includes(path)),
      sourceCapturedAt: captures,
      ...(verified ? { includeMatch: (match) => {
        if (!observations.has(match.id)) throw new Error(`Missing explicit observation for ${match.id}`)
        const included = group.gameIds.has(match.id) && match.date < group.cutoffDate
        if (included) sourceObservedAt.add(observations.get(match.id)!.observedAt)
        return included
      } } : {}),
    })
    if (!source.matches.length || source.dataMode === 'no-data') throw new Error('No usable retained ranking games')
    const inputs = source.matches.map(match => {
      const observation = observations.get(match.id)
      if (!observation) throw new Error(`Missing explicit observation for ${match.id}`)
      return { match, observedAt: observation.observedAt, resultAvailableAt: observation.resultAvailableAt }
    })
    const targets = group.indexes.map(index => requests.requests[index])
    if (simpleElo) {
      const replay = replaySimpleEloSeriesBatch(inputs, targets, requests.availability)
      batch.replayCount += replay.replayCount
      batch.replayedGames += replay.replayedGames
      group.indexes.forEach((index, offset) => {
        const result = replay.results[offset]
        eloResults[index] = { ...result, sourceObservedAt: [...new Set([...result.sourceObservedAt, ...sourceObservedAt])].sort((a, b) => a - b) }
      })
      continue
    }
    const lifecycleTargets = verified ? [targets.reduce((earliest, target) => target.asOf < earliest.asOf ? target : earliest)] : targets
    const lifecycles = lifecycleTargets.flatMap(request => deriveTournamentInstances({
      matches: inputs.filter(row => row.match.date < new Date(request.asOf).toISOString().slice(0, 10)
        && (row.resultAvailableAt === null ? !verified : row.resultAvailableAt <= request.asOf)
        && (!verified || row.observedAt <= request.asOf)).map(row => row.match),
      scheduleReferences: source.tournamentScheduleReferences.filter(reference => {
        const observedAt = Date.parse(reference.retrievedAt ?? '')
        return Number.isFinite(observedAt) && observedAt <= request.asOf
      }),
      generatedAt: new Date(request.asOf).toISOString(),
    }).map(instance => ({ tournamentId: instance.id, observedAt: request.asOf, lifecycle: {
      status: instance.status, boundaryDate: instance.boundaryDate, ratedThroughDate: instance.ratedThroughDate,
      dataLag: instance.dataLag, resultCoverageComplete: instance.resultCoverageComplete,
    } })))
    const replay = replayPregameSeriesBatch(inputs, targets, requests.availability, lifecycles)
    batch.replayCount += replay.replayCount
    batch.replayedGames += replay.replayedGames
    group.indexes.forEach((index, offset) => {
      const result = replay.results[offset]
      batch.results[index] = { ...result, sourceObservedAt: [...new Set([...result.sourceObservedAt,
        ...sourceObservedAt])].sort((a, b) => a - b) }
    })
  }
  const receipts = requests.requests.map((request, index) => {
    const replay = simpleElo ? eloResults[index] : batch.results[index]
    const state = { ...replay.state, usedGameIds: replay.usedGameIds }
    const modelStateHash = sha256(JSON.stringify(state))
    const modelStateId = `prior-date:${modelStateHash}`
    const generatedAt = Date.now()
    states.push({ modelStateId, modelStateHash, state })
    const metadata: PregameForecastMetadata = {
      candidateId: candidate.candidateId, parentCandidateId: candidate.parentCandidateId, modelCommit, sourceHash,
      configurationHash, dependencyLockHash, seriesId: request.seriesId, eventId: request.eventId,
      homeTeamId: request.homeTeamId, awayTeamId: request.awayTeamId, bestOf: request.bestOf,
      scheduleRevision: request.scheduleRevision, scheduledStartAt: request.scheduledStartAt,
      sideAssumption: 'neutral', lineupAssumption: 'prior-observed-roster', modelStateId, modelStateHash,
      inputManifestHash, inputDigests, generatedAt, asOf: request.asOf, validUntil: request.validUntil,
      sourceObservedAt: replay.sourceObservedAt, calibrationFit: candidate.calibrationFit,
      evidenceMode: requests.evidenceMode, availability: requests.availability,
    }
    return simpleElo ? predictSimpleEloSeries(eloResults[index].state, metadata)
      : predictPregameSeries({ state: batch.results[index].state, transform: candidate.transform, metadata })
  })
  for (const input of inputDigests) if (sha256(await readFile(input.path)) !== input.sha256) throw new Error(`Input changed during export: ${input.path}`)
  if (sha256(await readFile(resolve(manifestPath))) !== inputManifestHash) throw new Error('Manifest changed during export')
  const output = resolve(outputPath)
  await writeFile(`${output}.states.jsonl`, states.map(state => JSON.stringify(state)).join('\n') + '\n', { flag: 'wx' })
  await writeFile(`${output}.manifest.json`, JSON.stringify({ schemaVersion: 'pregame-export-v1', generatedAt: Date.now(), startedAt,
    modelCommit, sourceHash, sourceDigests, configurationHash, dependencyLockHash, inputManifestHash, inputDigests,
    evidenceMode: requests.evidenceMode, availability: requests.availability, exported: receipts.length, replayCount: batch.replayCount, replayedGames: batch.replayedGames }, null, 2) + '\n', { flag: 'wx' })
  await writeFile(output, receipts.map(receipt => JSON.stringify(receipt)).join('\n') + '\n', { flag: 'wx' })
  return receipts
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: export-pregame-series <manifest.json> <requests.json> <candidate.json> <output.jsonl>\nOffline only. Requests contain evidenceMode, availability, explicit game observations and canonical series identities. Existing outputs are never replaced.')
  } else {
    if (args.length !== 4) throw new Error('Usage: export-pregame-series <manifest.json> <requests.json> <candidate.json> <output.jsonl>')
    const receipts = await exportPregameSeries(args[0], args[1], args[2], args[3])
    console.log(JSON.stringify({ exported: receipts.length, eligible: receipts.filter(row => row.eligible).length, output: resolve(args[3]) }))
  }
}
