import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { buildPlayerModel } from '/home/codex/.t3/worktrees/lol-esports-ranking/fix-season-2026-match-audit/src/lib/model.ts'
import { buildPlayerModel as baselineModel } from '/tmp/lol-2026-audit-baseline/src/lib/model.ts'
import { prepareSemanticArtifact } from '/home/codex/.t3/worktrees/lol-esports-ranking/fix-season-2026-match-audit/scripts/public-artifact-storage.mjs'
import type { MatchRecord, MatchRosterSnapshot, Role, Side } from '/home/codex/.t3/worktrees/lol-esports-ranking/fix-season-2026-match-audit/src/types.ts'
const teams = { Alpha: {name:'Alpha',code:'ALP',region:'LCK',league:'LCK'}, Beta: {name:'Beta',code:'BET',region:'LCK',league:'LCK'} } as const
function sourcedPlayerMatchesWithSubstitutionAndCorrection(): MatchRecord[] {
  return Array.from({ length: 25 }, (_, index) => {
    const day = String(index + 1).padStart(2, '0')
    const entry = match(`player-${day}`, `2026-01-${day}`, 'Player Event')
    const winner = index % 2 === 0 ? 'Alpha' : 'Beta'
    return {
      ...entry,
      winner,
      teamARoster: sourcedRoster('alpha', 'blue', winner === 'Alpha', entry.date, {
        ...(index === 10 ? { Mid: { kills: 18 } } : {}),
      }),
      teamBRoster: sourcedRoster('beta', 'red', winner === 'Beta', entry.date, {}, {
        ...(index === 24 ? { Bot: 'beta-sub-Bot' } : {}),
      }),
    }
  })
}

function sourcedRoster(
  prefix: string,
  side: Side,
  won: boolean,
  observedAt: string,
  statOverrides: Partial<Record<Role, { kills?: number }>> = {},
  idOverrides: Partial<Record<Role, string>> = {},
): MatchRosterSnapshot {
  const roles: Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']
  return {
    sourceProvider: 'oracles-elixir',
    teamId: prefix,
    observedAt,
    completeness: 'complete-five-role',
    players: roles.map((role) => ({
      id: idOverrides[role] ?? `${prefix}-${role}`,
      name: idOverrides[role] ?? `${prefix} ${role}`,
      role,
      stats: {
        side,
        won,
        kills: statOverrides[role]?.kills ?? (won ? 4 : 2),
        deaths: won ? 2 : 4,
        assists: won ? 9 : 5,
        damageShare: 0.2,
        earnedGoldShare: 0.2,
        vspm: role === 'Support' ? 2.2 : 1,
      },
    })),
  }
}
function match(id: string, date: string, event: string, overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id, sourceProvider: 'oracles-elixir', sourceGameId: id, sourceMatchId: `series-${id}`,
    date, datetimeUtc: `${date}T12:00:00.000Z`, season: Number(date.slice(0, 4)), event,
    phase: 'Regular season', region: 'LCK', league: 'LCK', patch: '26.1', bestOf: 1,
    tier: 'regional-regular', teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha',
    teamAKills: 10, teamBKills: 5, teamAGold: 60_000, teamBGold: 55_000, ...overrides,
  }
}

const matches = sourcedPlayerMatchesWithSubstitutionAndCorrection()
const before = baselineModel(matches, {}, {teams})
const after = buildPlayerModel(matches, {}, {teams})
function normalize(value: unknown): unknown {
 if (Array.isArray(value)) return value.map(normalize)
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key, key === 'sourceSeriesId' && typeof item === 'string' && item.startsWith('source-match\u0000') ? [item.split('\u0000')[0], ...item.split('\u0000').slice(2)].join('\u0000') : normalize(item)]))
 return value
}
assert.deepEqual(after, normalize(before))
const summary = {onlyChange:'canonical sourceSeriesId omits date; every other player value matches baseline',digest:prepareSemanticArtifact({artifactKind:'player-model-regression',players:after}).digest}
await writeFile('/home/codex/.t3/worktrees/lol-esports-ranking/fix-season-2026-match-audit/.agents/artifacts/season-2026-audit/player-parity.json',JSON.stringify(summary,null,2)+'\n')
console.log(JSON.stringify(summary,null,2))
