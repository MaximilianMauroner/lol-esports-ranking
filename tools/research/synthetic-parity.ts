import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { exportPregameSeries, type ForecastCandidate, type ForecastRequestFile } from '../../scripts/rankings/export-pregame-series.ts'
import { importRankingSourceData } from '../../scripts/rankings/source-input.ts'
import { filePin, sha256, verifyForecastParity, type ParityConfiguration } from './forecast-parity.ts'

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)))

export async function createSyntheticParity(directory: string, consumerRoot: string) {
  await mkdir(directory, { recursive: true })
  const save = async (name: string, value: unknown) => {
    const path = join(directory, name)
    await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
    return path
  }
  const raw = { evidence: 'Synthetic test inputs. Not historical or prospective evidence.', fetchedAt: '2026-02-09T00:00:00Z',
    matches: ['2026-01-17', '2026-01-24', '2026-02-01'].map((date, index) => ({
      id: `synthetic-parity-${index}`, date, event: 'LCK 2026 Spring', phase: 'Regular season', season: 2026,
      region: 'LCK', league: 'LCK', tier: 'regional-regular', patch: '26.1', bestOf: 1,
      teamA: 'Gen.G', teamB: 'T1', winner: index === 1 ? 'T1' : 'Gen.G', teamAKills: 18, teamBKills: 12,
      teamAGold: 62000, teamBGold: 59000,
    })) }
  await save('synthetic-raw.json', raw)
  const manifest = await save('inputs.json', { files: { leaguepediaJson: ['synthetic-raw.json'], oracleCsv: [], lolEsportsJson: [] } })
  const source = await importRankingSourceData({ manifestPath: manifest })
  const asOf = Date.parse('2026-02-10T10:00:00Z')
  const requests: ForecastRequestFile = { evidenceMode: 'synthetic', availability: 'verified',
    observations: source.matches.map(match => ({ gameId: match.id, observedAt: Date.parse(match.date) + 3600_000,
      resultAvailableAt: Date.parse(match.date) + 3600_000 })),
    requests: ([1, 3, 5] as const).flatMap(bestOf => [false, true].map(swapped => ({
      seriesId: `synthetic-bo${bestOf}-${swapped ? 'away' : 'home'}`, eventId: 'synthetic-event',
      homeTeamId: swapped ? 't1' : 'gen', awayTeamId: swapped ? 'gen' : 't1',
      homeSourceTeam: swapped ? 'T1' : 'Gen.G', awaySourceTeam: swapped ? 'Gen.G' : 'T1', bestOf,
      scheduleRevision: 'synthetic-revision-1', scheduledStartAt: asOf + 7200_000, scheduleObservedAt: asOf - 1000,
      scheduleProvider: 'lolesports-schedule' as const, asOf, validUntil: asOf + 7000_000,
      event: 'LCK 2026 Spring', patch: '26.1', season: 2026, league: 'LCK', region: 'LCK' as const, tier: 'regional-regular' as const,
    }))) }
  const requestsPath = await save('requests.json', requests)
  const candidates: ForecastCandidate[] = [
    { candidateId: 'synthetic-rich-identity-v1', parentCandidateId: null, calibrationFit: null,
      transform: { temperature: 1, calibrationOrder: 'game-before-series', dependence: 0 } },
    { candidateId: 'simple-elo-v1', modelKind: 'simple-elo', parentCandidateId: null, calibrationFit: null,
      transform: { temperature: 1, calibrationOrder: 'game-before-series', dependence: 0 } },
  ]
  const configs: Array<{ path: string; sha256: string; configuration: ParityConfiguration }> = []
  const work = []
  for (const candidate of candidates) {
    const label = candidate.modelKind ?? 'ranking'
    const candidatePath = await save(`${label}-candidate.json`, candidate)
    const output = join(directory, `${label}.jsonl`)
    const receipts = await exportPregameSeries(manifest, requestsPath, candidatePath, output)
    const exported = JSON.parse(await readFile(`${output}.manifest.json`, 'utf8')) as { replayCount: number; replayedGames: number }
    const configuration: ParityConfiguration = {
      schema: 'forecast-consumer-parity-v1',
      consumer: { root: consumerRoot, sourceDigests: ['src/lol/forecast-import.ts', 'src/lol/contracts.ts', 'src/lol/money.ts']
        .map(path => ({ path, sha256: filePin(join(consumerRoot, path)).sha256 })) },
      exporter: { cwd: repository, node: process.execPath, entry: filePin(join(repository, 'scripts/rankings/export-pregame-series.ts')),
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
        manifest: filePin(manifest), requests: filePin(requestsPath), candidate: filePin(candidatePath), output, timeoutMs: 60_000 },
      artifacts: { forecast: filePin(output), manifest: filePin(`${output}.manifest.json`), states: filePin(`${output}.states.jsonl`) },
    }
    const configPath = await save(`${label}-parity.json`, configuration)
    configs.push({ path: configPath, sha256: filePin(configPath).sha256, configuration })
    work.push({ modelKind: label, exportPredictorCalls: receipts.length, syntheticReplays: exported.replayCount,
      syntheticReplayedGames: exported.replayedGames, parity: await verifyForecastParity(configuration) })
  }
  const result = { status: 'passed', evidence: 'synthetic-only', newHistoricalReplays: 0, modelAdopted: false,
    promotion: 'closed', configurations: configs.map(({ path, sha256 }) => ({ path, sha256 })), work }
  await save('synthetic-result.json', result)
  return { configurations: configs, result }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: synthetic-parity --output <new directory> --consumer-root <Gamba root>\nCreates labelled synthetic inputs with the real upstream exporter, then checks the actual Gamba importer and canonical saved-state predictions. Existing files are never replaced.')
  } else {
    if (args.length !== 4 || args[0] !== '--output' || args[2] !== '--consumer-root') throw new Error('Expected --output and --consumer-root')
    const { result } = await createSyntheticParity(resolve(args[1]), resolve(args[3]))
    console.log(JSON.stringify({ ...result, resultSha256: sha256(await readFile(join(resolve(args[1]), 'synthetic-result.json'))) }))
  }
}
