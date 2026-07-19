import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createStaticRankingData } from '../../src/lib/snapshot.ts'
import { createPublicArtifactWritePlan } from '../../src/lib/publicArtifacts/writePlan.ts'
import type { MatchRecord, MatchRosterSnapshot, PlayerProfile } from '../../src/types.ts'
import { rosters, sampleMatches, teams } from './rankingFixtures.ts'

export const PUBLIC_ARTIFACT_FIXTURE_RUN = {
  generatedAt: '2026-07-19T12:00:00.000Z',
  runId: 'fixture_public_artifacts_v1',
}

export const PUBLIC_ARTIFACT_FIXTURE_DIR = createFixtureBundle()

function createFixtureBundle() {
  const root = mkdtempSync(join(tmpdir(), 'lol-public-artifacts-'))
  process.once('exit', () => rmSync(root, { recursive: true, force: true }))
  const matches = fixtureMatches()
  const snapshot = createStaticRankingData({
    matches,
    teams,
    rosters,
    source: 'deterministic public artifact test fixture',
    externalSources: [{
      name: "Oracle's Elixir fixture CSV",
      kind: 'game-stats',
      description: 'Deterministic sourced-player and match rows used only by clean artifact-contract tests.',
      status: 'active',
      rowCount: matches.length,
      coverageStart: '2026-01-17',
      coverageEnd: '2026-05-02',
    }],
    runMetadata: PUBLIC_ARTIFACT_FIXTURE_RUN,
  })
  const plan = createPublicArtifactWritePlan(snapshot, { runMetadata: PUBLIC_ARTIFACT_FIXTURE_RUN })
  for (const write of plan.writes) {
    const path = join(root, write.relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, write.contents)
  }
  return root
}

function fixtureMatches(): MatchRecord[] {
  const originals = sampleMatches.map((match) => withOracleRosters(match))
  const domesticBase = sampleMatches[0]
  const additional = Array.from({ length: 27 }, (_, index) => {
    const day = String(index + 2).padStart(2, '0')
    const inFixtureSeries = index < 3
    const teamA = inFixtureSeries || index % 2 === 0 ? 'Gen.G' : 'T1'
    const teamB = teamA === 'Gen.G' ? 'T1' : 'Gen.G'
    return withOracleRosters({
      ...domesticBase,
      id: `fixture-volume-${String(index + 1).padStart(2, '0')}`,
      sourceGameId: `fixture-volume-game-${index + 1}`,
      sourceFileName: 'fixture-volume.csv',
      date: inFixtureSeries ? '2026-02-02' : `2026-02-${day}`,
      teamA,
      teamB,
      winner: inFixtureSeries ? (index === 1 ? teamB : teamA) : index % 3 === 0 ? teamB : teamA,
      ...(inFixtureSeries ? { sourceMatchId: 'fixture-volume-series', gameNumber: index + 1, bestOf: 3 } : {}),
    })
  })
  return [...originals, ...additional]
}

function withOracleRosters(match: MatchRecord): MatchRecord {
  const sourceGameId = match.sourceGameId ?? match.id
  return {
    ...match,
    sourceProvider: 'oracles-elixir',
    sourceGameId,
    sourceFileName: match.sourceFileName ?? 'fixture-oracle.csv',
    ...(rosters[match.teamA] ? { teamARoster: rosterSnapshot(rosters[match.teamA], match, match.teamA) } : {}),
    ...(rosters[match.teamB] ? { teamBRoster: rosterSnapshot(rosters[match.teamB], match, match.teamB) } : {}),
  }
}

function rosterSnapshot(players: PlayerProfile[], match: MatchRecord, team: string): MatchRosterSnapshot {
  const won = match.winner === team
  return {
    sourceProvider: 'oracles-elixir',
    observedAt: `${match.date}T12:00:00.000Z`,
    completeness: 'complete-five-role',
    players: players.map((player, index) => ({
      id: `oe:player:${player.name.toLowerCase()}`,
      name: player.name,
      role: player.role,
      stats: {
        side: team === match.teamA ? 'blue' : 'red',
        won,
        kills: won ? 4 + index : 1 + index,
        deaths: won ? 1 : 3,
        assists: won ? 8 : 4,
        totalGold: won ? 13_000 : 11_000,
        earnedGold: won ? 10_000 : 8_000,
        damageShare: [0.23, 0.16, 0.25, 0.28, 0.08][index],
        earnedGoldShare: [0.21, 0.18, 0.22, 0.25, 0.14][index],
        visionScore: 20 + index * 5,
        vspm: [0.9, 1.2, 1, 0.8, 2.4][index],
      },
    })),
  }
}
