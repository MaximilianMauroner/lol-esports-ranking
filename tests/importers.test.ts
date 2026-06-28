import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources.ts'
import { canonicalTeamNameFor, teamCodeFor } from '../src/data/teamIdentity.ts'
import { importLeaguepediaSnapshot } from '../src/lib/importers/leaguepedia.ts'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir.ts'
import { buildRankingModel } from '../src/lib/model.ts'
import type { MatchRecord, TeamProfile } from '../src/types.ts'

test('Leaguepedia international rows use known team home leagues when explicit fields are absent', () => {
  const result = importLeaguepediaSnapshot({
    source: 'fixture',
    fetchedAt: '2026-06-26T00:00:00.000Z',
    matches: [
      {
        id: 'lp-1',
        date: '2026-05-01',
        event: 'Mid-Season Invitational 2026',
        patch: '26.9',
        teamA: 'T1',
        teamB: 'Bilibili Gaming',
        winner: 'T1',
        teamAKills: 18,
        teamBKills: 12,
        teamAGold: 62000,
        teamBGold: 59000,
        bestOf: 5,
      },
    ],
  })

  const match = result.matches[0]
  assert.equal(match.teamAHomeLeague, 'LCK')
  assert.equal(match.teamBHomeLeague, 'LPL')
  assert.equal(result.teams.T1.league, 'LCK')
  assert.equal(result.teams['Bilibili Gaming'].league, 'LPL')

  const model = buildRankingModel(result.matches, result.teams)
  const lck = model.leagues.find((league) => league.league === 'LCK')
  const lpl = model.leagues.find((league) => league.league === 'LPL')
  assert.ok(lck)
  assert.ok(lpl)
  assert.equal(lck.internationalMatches, 1)
  assert.equal(lpl.internationalMatches, 1)
  assert.notEqual(lck.delta, 0)
  assert.notEqual(lpl.delta, 0)
})

test('Leaguepedia competition rows resolve exact team aliases before known identity fallback', () => {
  const result = importLeaguepediaSnapshot({
    source: 'fixture',
    fetchedAt: '2026-06-26T00:00:00.000Z',
    matches: [
      {
        id: 'lp-ewc-alias',
        date: '2025-07-19',
        event: 'Esports World Cup 2025',
        patch: '25.14',
        teamA: 'AG.AL',
        teamB: 'T1',
        winner: 'AG.AL',
        bestOf: 3,
      },
    ],
  })

  const match = result.matches[0]
  assert.equal(match.teamA, "Anyone's Legend")
  assert.equal(match.winner, "Anyone's Legend")
  assert.equal(match.teamAHomeLeague, 'LPL')
  assert.equal(match.teamARegion, 'LPL')
  assert.equal(result.teams["Anyone's Legend"].code, 'AL')
  assert.equal(result.teams["Anyone's Legend"].league, 'LPL')
})

test('Leaguepedia domestic rows keep sourced league over static known identity', () => {
  const result = importLeaguepediaSnapshot({
    source: 'fixture',
    fetchedAt: '2026-06-26T00:00:00.000Z',
    matches: [
      {
        id: 'lp-known-domestic',
        date: '2026-01-15',
        event: 'LFL 2026 Spring',
        teamA: 'G2 Esports',
        teamB: 'Solary',
        winner: 'G2 Esports',
      },
    ],
  })
  const match = result.matches[0]

  assert.equal(match.teamAHomeLeague, 'LFL')
  assert.equal(match.teamARegion, 'LEC')
  assert.equal(result.teams['G2 Esports'].league, 'LFL')
  assert.equal(result.teams['G2 Esports'].region, 'LEC')
})

test('Oracle domestic rows keep sourced league over static known identity', () => {
  const result = importOraclesElixirCsv([
    'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold',
    'oe-known-domestic,2026-01-15,2026,LFL,Spring,0,26.1,team,Blue,G2 Esports,1,20,65000',
    'oe-known-domestic,2026-01-15,2026,LFL,Spring,0,26.1,team,Red,Solary,0,12,59000',
  ].join('\n'))
  const match = result.matches[0]

  assert.equal(match.teamAHomeLeague, 'LFL')
  assert.equal(match.teamARegion, 'LEC')
  assert.equal(result.teams['G2 Esports'].league, 'LFL')
  assert.equal(result.teams['G2 Esports'].region, 'LEC')
})

test('Leaguepedia import decodes HTML entities before storing text fields', () => {
  const result = importLeaguepediaSnapshot({
    source: 'fixture',
    fetchedAt: '2026-06-26T00:00:00.000Z',
    matches: [
      {
        id: 'lp-entity-1',
        date: '2026-01-15',
        event: 'Superliga Domino&#039;s/2026 Season/Spring Split',
        teamA: 'Team&nbsp;One',
        teamB: 'Ruddy &#x26; Co',
        winner: 'Ruddy &#x26; Co',
      },
    ],
  })

  const match = result.matches[0]
  assert.equal(match.event, "Superliga Domino's/2026 Season/Spring Split")
  assert.equal(match.teamA, 'Team One')
  assert.equal(match.teamB, 'Ruddy & Co')
  assert.equal(match.winner, 'Ruddy & Co')
  assert.equal(match.league, 'LVP SL')
  assert.equal(match.region, 'LEC')
  assert.ok(result.teams['Ruddy & Co'])
})

test('Leaguepedia import infers known regional league aliases from event names', () => {
  const game = (id: string, event: string) => ({
    id,
    date: '2026-02-01',
    event,
    teamA: `${id} Alpha`,
    teamB: `${id} Beta`,
    winner: `${id} Alpha`,
  })
  const result = importLeaguepediaSnapshot({
    source: 'fixture',
    fetchedAt: '2026-06-26T00:00:00.000Z',
    matches: [
      game('prime', 'Prime League 1st Division/2026 Season/Winter Split'),
      game('hitpoint', 'Hitpoint Masters/2026 Season/Spring Split'),
      game('arabian', 'Arabian League/2026 Season/Spring Split'),
      game('lta-south', 'LTA South/2026 Season/Split 1'),
      game('lck-cl', 'LCK CL/2026 Season/Kickoff'),
      game('lck-academy', 'LCK Academy Series/2026 Season/1st Championship'),
      game('nacl', 'North American Challengers League/2026 Season/Spring Season'),
      game('rol', 'TransIP Road Of Legends/2025 Season/Spring Playoffs'),
      game('lfl2', 'LFL2/2026 Season/Spring Split'),
      game('nexus-league', 'Nexus League 2026'),
      game('circuito-tormenta', 'Circuito Tormenta 2025'),
      game('ebl', 'EBL 2026 Spring'),
      game('hll', 'HLL 2026 Winter'),
      game('lplol', 'LPLOL/2026 Season/Winter Split'),
      game('lrs', 'Liga Regional Sur/2026 Season/Split 1'),
      game('lts', 'LTS/2025 Season/Spring Season'),
    ],
  })
  const byId = new Map(result.matches.map((match) => [match.sourceGameId, match]))

  assert.equal(byId.get('prime')?.league, 'PRM')
  assert.equal(byId.get('hitpoint')?.league, 'HM')
  assert.equal(byId.get('arabian')?.league, 'AL')
  assert.equal(byId.get('lta-south')?.league, 'LTA S')
  assert.equal(byId.get('lta-south')?.region, 'CBLOL')
  assert.equal(byId.get('lck-cl')?.league, 'LCK CL')
  assert.equal(byId.get('lck-academy')?.league, 'LCK Academy')
  assert.equal(byId.get('nacl')?.league, 'NACL')
  assert.equal(byId.get('nacl')?.region, 'LCS')
  assert.equal(byId.get('rol')?.league, 'ROL')
  assert.equal(byId.get('rol')?.region, 'LEC')
  assert.equal(byId.get('lfl2')?.league, 'LFL2')
  assert.equal(byId.get('lfl2')?.region, 'LEC')
  assert.equal(byId.get('nexus-league')?.league, 'NL')
  assert.equal(byId.get('nexus-league')?.region, 'LEC')
  assert.equal(byId.get('circuito-tormenta')?.league, 'CT')
  assert.equal(byId.get('circuito-tormenta')?.region, 'LEC')
  assert.equal(byId.get('ebl')?.league, 'EBL')
  assert.equal(byId.get('ebl')?.region, 'LEC')
  assert.equal(byId.get('hll')?.league, 'HLL')
  assert.equal(byId.get('hll')?.region, 'LEC')
  assert.equal(byId.get('lplol')?.league, 'LPLOL')
  assert.equal(byId.get('lplol')?.region, 'LEC')
  assert.equal(byId.get('lrs')?.league, 'LRS')
  assert.equal(byId.get('lrs')?.region, 'CBLOL')
  assert.equal(byId.get('lts')?.league, 'LTS')
  assert.equal(byId.get('lts')?.region, 'LCP')
})

test('community merge keeps same-day scored series games but drops incomplete Leaguepedia duplicates after Oracle', () => {
  const teams: Record<string, TeamProfile> = {
    T1: { name: 'T1', code: 'T1', region: 'LCK', league: 'LCK' },
    'Gen.G': { name: 'Gen.G', code: 'GEN', region: 'LCK', league: 'LCK' },
  }
  const oracleMatch: MatchRecord = matchFixture({
    id: 'oe-1',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'oe-game-1',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
  })
  const leaguepediaDuplicate: MatchRecord = matchFixture({
    id: 'lp-duplicate',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'different-lp-id',
    dataCompleteness: 'match-result-only',
    teamAKills: 0,
    teamBKills: 0,
    teamAGold: 0,
    teamBGold: 0,
  })
  const leaguepediaSecondGame: MatchRecord = matchFixture({
    id: 'lp-game-2',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'lp-game-2',
    dataCompleteness: 'scoreboard-game-stats',
    teamAKills: 14,
    teamBKills: 21,
    teamAGold: 60200,
    teamBGold: 67100,
    winner: 'Gen.G',
  })

  const merged = mergeCommunityMatchSources({
    oracleMatches: [oracleMatch],
    leaguepediaMatches: [leaguepediaDuplicate, leaguepediaSecondGame],
  })

  assert.deepEqual(merged.map((match) => match.id), ['oe-1', 'lp-game-2'])
  assert.equal(buildRankingModel(merged, teams).standings.length, 2)
})

test('community merge drops exact scored Leaguepedia duplicates with different source ids after Oracle', () => {
  const oracleMatch: MatchRecord = matchFixture({
    id: 'oe-scored',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'oe-scored-id',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
  })
  const leaguepediaScoredDuplicate: MatchRecord = matchFixture({
    id: 'lp-scored',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'lp-scored-id',
    dataCompleteness: 'scoreboard-game-stats',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
    gameLengthSeconds: undefined,
  })
  const leaguepediaExtraSameOutcome: MatchRecord = matchFixture({
    id: 'lp-extra-same-outcome',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'lp-extra-same-outcome',
    dataCompleteness: 'scoreboard-game-stats',
    teamAKills: 22,
    teamBKills: 14,
    teamAGold: 68000,
    teamBGold: 60000,
    gameLengthSeconds: undefined,
  })

  const merged = mergeCommunityMatchSources({
    oracleMatches: [oracleMatch],
    leaguepediaMatches: [leaguepediaScoredDuplicate, leaguepediaExtraSameOutcome],
  })

  assert.deepEqual(merged.map((match) => match.id), ['oe-scored', 'lp-extra-same-outcome'])
})

test('community merge keeps Oracle stats but adopts Leaguepedia qualifier metadata for duplicates', () => {
  const oracleMatch: MatchRecord = matchFixture({
    id: 'oe-ewc-qualifier',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'oe-ewc-id',
    event: 'EWC 2026',
    league: 'EWC',
    region: 'International',
    tier: 'minor-international',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
  })
  const leaguepediaQualifierDuplicate: MatchRecord = matchFixture({
    id: 'lp-ewc-qualifier',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'lp-ewc-qualifier-id',
    event: 'Esports World Cup 2026/Online Qualifiers/North America',
    phase: 'Regular season',
    league: 'EWC',
    region: 'International',
    tier: 'qualifier',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
    gameLengthSeconds: undefined,
  })

  const merged = mergeCommunityMatchSources({
    oracleMatches: [oracleMatch],
    leaguepediaMatches: [leaguepediaQualifierDuplicate],
  })

  assert.equal(merged.length, 1)
  assert.equal(merged[0].sourceProvider, 'oracles-elixir')
  assert.equal(merged[0].sourceGameId, 'oe-ewc-id')
  assert.equal(merged[0].sourceMatchId, 'lp-ewc-qualifier-id')
  assert.equal(merged[0].event, 'Esports World Cup 2026/Online Qualifiers/North America')
  assert.equal(merged[0].tier, 'qualifier')
  assert.equal(merged[0].teamAKills, 20)
  assert.equal(merged[0].teamAGold, 65000)
})

test('community merge upgrades Oracle duplicate tier and best-of from stronger Leaguepedia metadata', () => {
  const oracleMatch: MatchRecord = matchFixture({
    id: 'oe-msi-final-game',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'oe-msi-final-game-id',
    date: '2025-07-13',
    event: 'MSI 2025',
    phase: 'Regular season',
    region: 'International',
    league: 'MSI',
    tier: 'msi-play-in',
    bestOf: 1,
    teamA: 'Gen.G',
    teamB: 'T1',
    winner: 'Gen.G',
    teamAKills: 24,
    teamBKills: 10,
    teamAGold: 62122,
    teamBGold: 49028,
  })
  const leaguepediaDuplicate: MatchRecord = matchFixture({
    id: 'lp-msi-final-game',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: '2025 Mid-Season Invitational_Finals_1_2',
    date: '2025-07-13',
    event: '2025 Mid-Season Invitational',
    phase: 'Playoffs',
    region: 'International',
    league: 'MSI',
    tier: 'msi-bracket',
    bestOf: 5,
    teamA: 'Gen.G',
    teamB: 'T1',
    winner: 'Gen.G',
    teamAKills: 24,
    teamBKills: 10,
    teamAGold: 62122,
    teamBGold: 49028,
  })

  const merged = mergeCommunityMatchSources({
    oracleMatches: [oracleMatch],
    leaguepediaMatches: [leaguepediaDuplicate],
  })

  assert.equal(merged.length, 1)
  assert.equal(merged[0].sourceProvider, 'oracles-elixir')
  assert.equal(merged[0].event, 'MSI 2025')
  assert.equal(merged[0].phase, 'Playoffs')
  assert.equal(merged[0].tier, 'msi-bracket')
  assert.equal(merged[0].bestOf, 5)
  assert.equal(merged[0].sourceMatchId, '2025 Mid-Season Invitational_Finals_1_2')
})

test('community merge keeps distinct scored same-winner series games', () => {
  const oracleMatch: MatchRecord = matchFixture({
    id: 'oe-series-game-3',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'oe-series-game-3-id',
    teamA: 'G2 Esports',
    teamB: 'Bilibili Gaming',
    winner: 'Bilibili Gaming',
    teamAKills: 2,
    teamBKills: 17,
    teamAGold: 54647,
    teamBGold: 67901,
  })
  const leaguepediaEarlierSameWinnerGame: MatchRecord = matchFixture({
    id: 'lp-series-game-2',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'lp-series-game-2-id',
    teamA: 'G2 Esports',
    teamB: 'Bilibili Gaming',
    winner: 'Bilibili Gaming',
    teamAKills: 9,
    teamBKills: 20,
    teamAGold: 51895,
    teamBGold: 59358,
  })
  const leaguepediaExactDuplicate: MatchRecord = matchFixture({
    id: 'lp-series-game-3',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'lp-series-game-3-id',
    teamA: 'G2 Esports',
    teamB: 'Bilibili Gaming',
    winner: 'Bilibili Gaming',
    teamAKills: 2,
    teamBKills: 17,
    teamAGold: 54647,
    teamBGold: 67901,
  })

  const merged = mergeCommunityMatchSources({
    oracleMatches: [oracleMatch],
    leaguepediaMatches: [leaguepediaEarlierSameWinnerGame, leaguepediaExactDuplicate],
  })

  assert.deepEqual(merged.map((match) => match.id), ['oe-series-game-3', 'lp-series-game-2'])
})

test('team identity cleanup maps exact source display aliases only', () => {
  assert.equal(canonicalTeamNameFor('LYON (2024 American Team)'), 'LYON')
  assert.equal(canonicalTeamNameFor('Ninjas in Pyjamas.CN'), 'Ninjas in Pyjamas')
  assert.equal(canonicalTeamNameFor('Rogue (European Team)'), 'Rogue')
  assert.equal(canonicalTeamNameFor('Team Secret (Vietnamese Team)'), 'Team Secret')
  assert.equal(canonicalTeamNameFor('Team Secret Whales'), 'Team Secret Whales')
  assert.equal(canonicalTeamNameFor('ZEN Esports (Vietnamese Team)'), 'ZEN Esports')
  assert.equal(canonicalTeamNameFor('9Gaming Esports'), '9Gaming')
  assert.equal(canonicalTeamNameFor('AG.AL'), "Anyone's Legend")
  assert.equal(canonicalTeamNameFor('OKSavingsBank BRION'), 'HANJIN BRION')
  assert.equal(canonicalTeamNameFor('DN Freecs'), 'DN SOOPers')
  assert.equal(canonicalTeamNameFor('DRX'), 'Kiwoom DRX')
  assert.equal(canonicalTeamNameFor('Dplus Kia'), 'Dplus KIA')
  assert.equal(canonicalTeamNameFor('Dplus KIA'), 'Dplus KIA')
  assert.equal(canonicalTeamNameFor('Dplus KIA Challengers'), 'Dplus Kia Challengers')
  assert.equal(canonicalTeamNameFor('Dplus KIA Youth'), 'Dplus Kia Youth')
  assert.equal(canonicalTeamNameFor('LYON Academy'), 'LYON Academy')
  assert.equal(canonicalTeamNameFor('The Secret Club'), 'The Secret Club')
})

test('team code cleanup uses known source abbreviations for major teams', () => {
  const identities = [
    ['LNG Esports', 'LNG'],
    ['EDward Gaming', 'EDG'],
    ["Anyone's Legend", 'AL'],
    ['AG.AL', 'AL'],
    ['KT Rolster', 'KT'],
    ['BNK FEARX', 'BFX'],
    ['Dplus Kia', 'DK'],
    ['DRX', 'KRX'],
  ] as const

  for (const [team, code] of identities) {
    assert.equal(teamCodeFor(team), code)
  }
})

test('community merge drops Leaguepedia alias duplicates after Oracle while keeping real second games', () => {
  const oracleMatch: MatchRecord = matchFixture({
    id: 'oe-alias',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'oe-alias-id',
    teamA: 'Dplus Kia',
    teamB: 'Ninjas in Pyjamas',
    winner: 'Dplus Kia',
  })
  const leaguepediaAliasDuplicate: MatchRecord = matchFixture({
    id: 'lp-alias-duplicate',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'lp-alias-duplicate-id',
    teamA: 'Dplus KIA',
    teamB: 'Ninjas in Pyjamas.CN',
    winner: 'Dplus KIA',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
  })
  const leaguepediaSecondGame: MatchRecord = matchFixture({
    id: 'lp-alias-game-2',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'lp-alias-game-2-id',
    teamA: 'Dplus KIA',
    teamB: 'Ninjas in Pyjamas.CN',
    winner: 'Ninjas in Pyjamas.CN',
    teamAKills: 11,
    teamBKills: 18,
    teamAGold: 58500,
    teamBGold: 64200,
  })

  const merged = mergeCommunityMatchSources({
    oracleMatches: [oracleMatch],
    leaguepediaMatches: [leaguepediaAliasDuplicate, leaguepediaSecondGame],
  })

  assert.deepEqual(merged.map((match) => match.id), ['oe-alias', 'lp-alias-game-2'])
})

test('community merge adopts qualifier metadata across Team Secret rebrand aliases', () => {
  const oracleMatch: MatchRecord = matchFixture({
    id: 'oe-team-secret-ewc',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'oe-team-secret-ewc-id',
    date: '2026-05-20',
    event: 'EWC 2026',
    league: 'EWC',
    region: 'International',
    tier: 'minor-international',
    teamA: 'Team Secret',
    teamB: 'GAM Esports',
    winner: 'Team Secret',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
  })
  const leaguepediaQualifierDuplicate: MatchRecord = matchFixture({
    id: 'lp-team-secret-ewc',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'lp-team-secret-ewc-id',
    date: '2026-05-20',
    event: 'Esports World Cup 2026/Online Qualifiers/Asia-Pacific',
    phase: 'Regular season',
    league: 'EWC',
    region: 'International',
    tier: 'qualifier',
    teamA: 'Team Secret (Vietnamese Team)',
    teamB: 'GAM Esports',
    winner: 'Team Secret (Vietnamese Team)',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
    gameLengthSeconds: undefined,
  })

  const merged = mergeCommunityMatchSources({
    oracleMatches: [oracleMatch],
    leaguepediaMatches: [leaguepediaQualifierDuplicate],
  })

  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'oe-team-secret-ewc')
  assert.equal(merged[0].teamA, 'Team Secret')
  assert.equal(merged[0].sourceMatchId, 'lp-team-secret-ewc-id')
  assert.equal(merged[0].event, 'Esports World Cup 2026/Online Qualifiers/Asia-Pacific')
  assert.equal(merged[0].tier, 'qualifier')
})

test('community merge drops Leaguepedia sponsor-name duplicates after Oracle', () => {
  const oracleBrionGame: MatchRecord = matchFixture({
    id: 'oe-brion',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'oe-brion-id',
    date: '2025-01-23',
    teamA: 'Gen.G',
    teamB: 'HANJIN BRION',
    winner: 'HANJIN BRION',
  })
  const leaguepediaBrionDuplicate: MatchRecord = matchFixture({
    id: 'lp-brion',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'lp-brion-id',
    date: '2025-01-23',
    teamA: 'Gen.G',
    teamB: 'OKSavingsBank BRION',
    winner: 'OKSavingsBank BRION',
  })
  const oracleDnGame: MatchRecord = matchFixture({
    id: 'oe-dn',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'oe-dn-id',
    date: '2025-01-25',
    teamA: 'Gen.G',
    teamB: 'DN SOOPers',
    winner: 'Gen.G',
  })
  const leaguepediaDnDuplicate: MatchRecord = matchFixture({
    id: 'lp-dn',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'lp-dn-id',
    date: '2025-01-25',
    teamA: 'Gen.G',
    teamB: 'DN Freecs',
    winner: 'Gen.G',
  })

  const merged = mergeCommunityMatchSources({
    oracleMatches: [oracleBrionGame, oracleDnGame],
    leaguepediaMatches: [leaguepediaBrionDuplicate, leaguepediaDnDuplicate],
  })

  assert.deepEqual(merged.map((match) => match.id), ['oe-brion', 'oe-dn'])
})

test('community merge keeps affiliate teams distinct from parent team aliases', () => {
  const oracleMatch: MatchRecord = matchFixture({
    id: 'oe-parent',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'oe-parent-id',
    teamA: 'Dplus Kia',
    teamB: 'LYON',
    winner: 'Dplus Kia',
  })
  const leaguepediaAffiliateGame: MatchRecord = matchFixture({
    id: 'lp-affiliate',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'lp-affiliate-id',
    teamA: 'Dplus KIA Challengers',
    teamB: 'LYON Academy',
    winner: 'Dplus KIA Challengers',
    teamAKills: 21,
    teamBKills: 13,
    teamAGold: 66200,
    teamBGold: 60100,
  })

  const merged = mergeCommunityMatchSources({
    oracleMatches: [oracleMatch],
    leaguepediaMatches: [leaguepediaAffiliateGame],
  })

  assert.deepEqual(merged.map((match) => match.id), ['oe-parent', 'lp-affiliate'])
})

test('Oracle import preserves blue and red side metadata', () => {
  const result = importOraclesElixirCsv([
    'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold',
    'oe-side-1,2026-01-01,2026,LCK,Spring,0,26.1,team,Blue,T1,1,20,65000',
    'oe-side-1,2026-01-01,2026,LCK,Spring,0,26.1,team,Red,Gen.G,0,12,59000',
  ].join('\n'))

  assert.equal(result.matches[0]?.teamASide, 'blue')
  assert.equal(result.matches[0]?.teamBSide, 'red')
})

test('Oracle import treats First Stand as an MSI-level international bracket signal', () => {
  const result = importOraclesElixirCsv([
    'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold',
    'oe-fst-1,2026-03-21,2026,FST,,0,26.5,team,Blue,G2 Esports,1,20,65000',
    'oe-fst-1,2026-03-21,2026,FST,,0,26.5,team,Red,Gen.G,0,12,59000',
  ].join('\n'))
  const match = result.matches[0]

  assert.equal(match?.region, 'International')
  assert.equal(match?.tier, 'msi-bracket')
  assert.equal(match?.teamAHomeLeague, 'LEC')
  assert.equal(match?.teamBHomeLeague, 'LCK')
  assert.equal(result.teams['G2 Esports'].league, 'LEC')
  assert.equal(result.teams['Gen.G'].league, 'LCK')
})

test('Leaguepedia import treats First Stand as an MSI-level international bracket signal', () => {
  const result = importLeaguepediaSnapshot({
    source: 'fixture',
    fetchedAt: '2026-06-26T00:00:00.000Z',
    matches: [
      {
        id: 'lp-fst-1',
        date: '2026-03-21',
        event: 'First Stand 2026/Bracket Stage',
        teamA: 'G2 Esports',
        teamB: 'Gen.G',
        winner: 'G2 Esports',
      },
    ],
  })
  const match = result.matches[0]

  assert.equal(match?.league, 'FST')
  assert.equal(match?.region, 'International')
  assert.equal(match?.tier, 'msi-bracket')
  assert.equal(match?.teamAHomeLeague, 'LEC')
  assert.equal(match?.teamBHomeLeague, 'LCK')
})

test('Leaguepedia import treats Mid-Season Invitational bracket and final ids as MSI bracket signal', () => {
  const result = importLeaguepediaSnapshot({
    source: 'fixture',
    fetchedAt: '2026-06-26T00:00:00.000Z',
    matches: [
      {
        id: '2025 Mid-Season Invitational_Bracket Round 2_1_5',
        date: '2025-07-05',
        datetimeUtc: '2025-07-05 03:17:00',
        event: '2025 Mid-Season Invitational',
        teamA: 'Gen.G',
        teamB: "Anyone's Legend",
        winner: 'Gen.G',
      },
      {
        id: '2025 Mid-Season Invitational_Finals_1_1',
        date: '2025-07-13',
        datetimeUtc: '2025-07-13 00:16:00',
        event: '2025 Mid-Season Invitational',
        teamA: 'Gen.G',
        teamB: 'T1',
        winner: 'Gen.G',
      },
    ],
  })

  assert.deepEqual(result.matches.map((match) => match.phase), ['Playoffs', 'Playoffs'])
  assert.deepEqual(result.matches.map((match) => match.tier), ['msi-bracket', 'msi-bracket'])
  assert.deepEqual(result.matches.map((match) => match.bestOf), [5, 5])
})

test('Oracle import treats EMEA Masters as competition-only instead of a team home league', () => {
  const result = importOraclesElixirCsv([
    'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold',
    'oe-em-1,2026-06-12,2026,EM,Spring,0,26.11,team,Blue,Karmine Corp Blue,1,20,65000',
    'oe-em-1,2026-06-12,2026,EM,Spring,0,26.11,team,Red,Forsaken,0,12,59000',
  ].join('\n'))
  const match = result.matches[0]

  assert.equal(match?.tier, 'minor-international')
  assert.equal(match?.teamAHomeLeague, undefined)
  assert.equal(result.teams['Karmine Corp Blue'].league, 'Unknown')
})

test('Oracle import treats generic LTA as a competition layer instead of team home league', () => {
  const result = importOraclesElixirCsv([
    'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold',
    'oe-lta-1,2025-09-27,2025,LTA,,0,25.18,team,Blue,100 Thieves,1,20,65000',
    'oe-lta-1,2025-09-27,2025,LTA,,0,25.18,team,Red,Shopify Rebellion,0,12,59000',
  ].join('\n'))
  const match = result.matches[0]

  assert.equal(match?.league, 'LTA')
  assert.equal(match?.teamAHomeLeague, undefined)
  assert.equal(match?.teamBHomeLeague, undefined)
  assert.equal(result.teams['100 Thieves'].league, 'Unknown')
})

test('Leaguepedia import treats generic LTA as a competition layer instead of current identity', () => {
  const result = importLeaguepediaSnapshot({
    source: 'fixture',
    fetchedAt: '2026-06-26T00:00:00.000Z',
    matches: [
      {
        id: 'lp-lta-1',
        date: '2025-09-27',
        event: 'LTA 2025 Championship',
        teamA: '100 Thieves',
        teamB: 'Shopify Rebellion',
        winner: '100 Thieves',
      },
    ],
  })
  const match = result.matches[0]

  assert.equal(match?.league, 'LTA')
  assert.equal(match?.teamAHomeLeague, 'Unknown')
  assert.equal(match?.teamARegion, 'International')
  assert.equal(result.teams['100 Thieves'].league, 'Unknown')
})

test('Leaguepedia import treats global invitationals as competition-only events', () => {
  const result = importLeaguepediaSnapshot({
    source: 'fixture',
    fetchedAt: '2026-06-26T00:00:00.000Z',
    matches: [
      {
        id: 'lp-ewc-1',
        date: '2026-05-05',
        event: 'Esports World Cup 2026/Online Qualifiers/Asia-Pacific',
        teamA: 'G2 Esports',
        teamB: 'T1',
        winner: 'G2 Esports',
      },
    ],
  })
  const match = result.matches[0]

  assert.equal(match?.league, 'EWC')
  assert.equal(match?.region, 'International')
  assert.equal(match?.tier, 'qualifier')
  assert.equal(match?.teamAHomeLeague, 'LEC')
  assert.equal(match?.teamBHomeLeague, 'LCK')
})

test('Oracle import classifies WLDs abbreviation as Worlds tier', () => {
  const result = importOraclesElixirCsv([
    'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold',
    'oe-wlds-1,2025-10-20,2025,WLDs,,0,25.20,team,Blue,T1,1,20,65000',
    'oe-wlds-1,2025-10-20,2025,WLDs,,0,25.20,team,Red,Bilibili Gaming,0,12,59000',
  ].join('\n'))
  const match = result.matches[0]

  assert.equal(match?.region, 'International')
  assert.equal(match?.tier, 'worlds-main')
  assert.equal(match?.teamAHomeLeague, 'LCK')
  assert.equal(match?.teamBHomeLeague, 'LPL')
})

test('importers do not classify academic world tournaments as Worlds tier', () => {
  const leaguepedia = importLeaguepediaSnapshot({
    source: 'fixture',
    fetchedAt: '2026-06-26T00:00:00.000Z',
    matches: [
      {
        id: 'lp-academic-world-1',
        date: '2026-02-01',
        event: '2026 Academic Esports World Tournament Sydney',
        teamA: 'University Alpha',
        teamB: 'University Beta',
        winner: 'University Alpha',
      },
    ],
  })
  const oracle = importOraclesElixirCsv([
    'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold',
    'oe-academic-world-1,2026-02-01,2026,Academic Esports World Tournament Sydney,,0,26.2,team,Blue,University Alpha,1,20,65000',
    'oe-academic-world-1,2026-02-01,2026,Academic Esports World Tournament Sydney,,0,26.2,team,Red,University Beta,0,12,59000',
  ].join('\n'))

  assert.equal(leaguepedia.matches[0]?.tier, 'qualifier')
  assert.equal(oracle.matches[0]?.tier, 'qualifier')
})

test('Demacia Cup is an LPL regional cup, not an international event', () => {
  const leaguepedia = importLeaguepediaSnapshot({
    source: 'fixture',
    fetchedAt: '2026-06-26T00:00:00.000Z',
    matches: [
      {
        id: 'lp-dcup-1',
        date: '2025-12-20',
        event: 'Demacia Cup 2025',
        teamA: 'Bilibili Gaming',
        teamB: 'JD Gaming',
        winner: 'Bilibili Gaming',
      },
    ],
  })
  const oracle = importOraclesElixirCsv([
    'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold',
    'oe-dcup-1,2025-12-20,2025,DCup,,0,25.24,team,Blue,Bilibili Gaming,1,20,65000',
    'oe-dcup-1,2025-12-20,2025,DCup,,0,25.24,team,Red,JD Gaming,0,12,59000',
  ].join('\n'))

  assert.equal(leaguepedia.matches[0]?.league, 'DCup')
  assert.equal(leaguepedia.matches[0]?.region, 'LPL')
  assert.equal(leaguepedia.matches[0]?.tier, 'regional-regular')
  assert.equal(oracle.matches[0]?.region, 'LPL')
  assert.equal(oracle.matches[0]?.tier, 'regional-regular')
})

test('Leaguepedia import treats EMEA Masters as competition-only without explicit home leagues', () => {
  const result = importLeaguepediaSnapshot({
    source: 'fixture',
    fetchedAt: '2026-06-26T00:00:00.000Z',
    matches: [
      {
        id: 'lp-em-1',
        date: '2026-06-12',
        event: 'EMEA Masters/2026 Season/Spring Main Event',
        teamA: 'Karmine Corp Blue',
        teamB: 'Forsaken',
        winner: 'Karmine Corp Blue',
      },
    ],
  })
  const match = result.matches[0]

  assert.equal(match?.league, 'EMEA Masters')
  assert.equal(match?.tier, 'minor-international')
  assert.equal(match?.teamAHomeLeague, 'Unknown')
  assert.equal(result.teams['Karmine Corp Blue'].league, 'Unknown')
})

test('Oracle import maps player rows into sourced game rosters', () => {
  const result = importOraclesElixirCsv([
    'gameid,date,year,league,split,playoffs,patch,position,side,playername,playerid,teamname,teamid,result,kills,deaths,assists,totalgold,earnedgold,damageshare,earnedgoldshare,visionscore,vspm,champion',
    'oe-roster-1,2026-01-01,2026,LCK,Spring,0,26.1,team,Blue,,team-blue,T1,team-t1,1,20,0,0,65000,61000,,,,,',
    'oe-roster-1,2026-01-01,2026,LCK,Spring,0,26.1,team,Red,,team-red,Gen.G,team-gen,0,12,0,0,59000,55500,,,,,',
    'oe-roster-1,2026-01-01,2026,LCK,Spring,0,26.1,top,Blue,Zeus,p-top,T1,team-t1,1,4,1,8,12000,11000,0.22,0.20,28,0.85,Aatrox',
    'oe-roster-1,2026-01-01,2026,LCK,Spring,0,26.1,jng,Blue,Oner,p-jng,T1,team-t1,1,3,2,9,11000,10200,0.14,0.17,44,1.35,Vi',
    'oe-roster-1,2026-01-01,2026,LCK,Spring,0,26.1,mid,Blue,Faker,p-mid,T1,team-t1,1,5,1,10,13000,12200,0.27,0.22,34,1.05,Azir',
    'oe-roster-1,2026-01-01,2026,LCK,Spring,0,26.1,bot,Blue,Gumayusi,p-bot,T1,team-t1,1,7,0,7,15000,14200,0.31,0.25,26,0.78,Jinx',
    'oe-roster-1,2026-01-01,2026,LCK,Spring,0,26.1,sup,Blue,Keria,p-sup,T1,team-t1,1,1,3,16,9000,8200,0.06,0.13,82,2.54,Rakan',
    'oe-roster-1,2026-01-01,2026,LCK,Spring,0,26.1,top,Red,Kiin,g-top,Gen.G,team-gen,0,1,4,5,11000,10400,0.19,0.19,23,0.7,Ksante',
    'oe-roster-1,2026-01-01,2026,LCK,Spring,0,26.1,jng,Red,Canyon,g-jng,Gen.G,team-gen,0,2,4,6,10500,9900,0.13,0.18,38,1.2,Sejuani',
    'oe-roster-1,2026-01-01,2026,LCK,Spring,0,26.1,mid,Red,Chovy,g-mid,Gen.G,team-gen,0,3,3,4,12500,11900,0.25,0.21,31,0.95,Orianna',
    'oe-roster-1,2026-01-01,2026,LCK,Spring,0,26.1,bot,Red,Ruler,g-bot,Gen.G,team-gen,0,5,3,3,14500,13600,0.29,0.24,24,0.72,Aphelios',
    'oe-roster-1,2026-01-01,2026,LCK,Spring,0,26.1,sup,Red,Duro,g-sup,Gen.G,team-gen,0,1,6,7,8500,7900,0.05,0.12,74,2.3,Nautilus',
  ].join('\n'))
  const match = result.matches[0]
  const faker = match?.teamARoster?.players.find((player) => player.id === 'p-mid')

  assert.equal(match?.teamARoster?.completeness, 'complete-five-role')
  assert.equal(match?.teamBRoster?.completeness, 'complete-five-role')
  assert.equal(match?.teamARoster?.teamId, 'team-t1')
  assert.equal(match?.teamARoster?.observedAt, '2026-01-01')
  assert.deepEqual(match?.teamARoster?.players.map((player) => player.role), ['Top', 'Jungle', 'Mid', 'Bot', 'Support'])
  assert.equal(match?.teamARoster?.players.find((player) => player.id === 'p-jng')?.name, 'Oner')
  assert.equal(match?.teamARoster?.players.find((player) => player.id === 'p-sup')?.role, 'Support')
  assert.equal(faker?.stats?.champion, 'Azir')
  assert.equal(faker?.stats?.won, true)
  assert.equal(faker?.stats?.kills, 5)
  assert.equal(faker?.stats?.deaths, 1)
  assert.equal(faker?.stats?.assists, 10)
  assert.equal(faker?.stats?.totalGold, 13000)
  assert.equal(faker?.stats?.earnedGold, 12200)
  assert.equal(faker?.stats?.damageShare, 0.27)
  assert.equal(faker?.stats?.earnedGoldShare, 0.22)
  assert.equal(faker?.stats?.visionScore, 34)
  assert.equal(faker?.stats?.vspm, 1.05)
})

test('Oracle import applies exact player id aliases without fuzzy same-name merging', () => {
  const result = importOraclesElixirCsv([
    'gameid,date,year,league,split,playoffs,patch,position,side,playername,playerid,teamname,teamid,result,kills,totalgold',
    'new-meta-1,2026-02-23,2026,LJL,Winter,1,16.04,team,Blue,,team-blue,New Meta,team-new-meta,1,18,65000',
    'new-meta-1,2026-02-23,2026,LJL,Winter,1,16.04,team,Red,,team-red,DetonatioN FocusMe,team-dfm,0,12,59000',
    'new-meta-1,2026-02-23,2026,LJL,Winter,1,16.04,top,Blue,advance,oe:player:ec32405553073660d757af1100d45b7,New Meta,team-new-meta,1,4,12000',
    'new-meta-1,2026-02-23,2026,LJL,Winter,1,16.04,top,Red,advance,oe:player:unrelated-same-handle,DetonatioN FocusMe,team-dfm,0,2,11000',
    'new-meta-2,2026-03-08,2026,LJL,Winter,1,16.05,team,Blue,,team-blue,New Meta,team-new-meta,1,18,65000',
    'new-meta-2,2026-03-08,2026,LJL,Winter,1,16.05,team,Red,,team-red,DetonatioN FocusMe,team-dfm,0,12,59000',
    'new-meta-2,2026-03-08,2026,LJL,Winter,1,16.05,top,Blue,advance,oe:player:0a86dddc699c7e6fe7f1e43153a5cbe,New Meta,team-new-meta,1,4,12000',
    'new-meta-2,2026-03-08,2026,LJL,Winter,1,16.05,top,Red,advance,oe:player:unrelated-same-handle,DetonatioN FocusMe,team-dfm,0,2,11000',
    'mvk-1,2025-05-30,2025,LCP,Split 2,0,15.10,team,Blue,,team-mvk,MGN Vikings Esports,team-mvk,1,17,64000',
    'mvk-1,2025-05-30,2025,LCP,Split 2,0,15.10,team,Red,,team-tsw,Team Secret Whales,team-tsw,0,10,58000',
    'mvk-1,2025-05-30,2025,LCP,Split 2,0,15.10,top,Blue,Kratos,oe:player:fa6ab005227d25bf19d02ca58f00cab,MGN Vikings Esports,team-mvk,1,5,12500',
    'mvk-1,2025-05-30,2025,LCP,Split 2,0,15.10,top,Red,Hasmed,oe:player:hasmed,Team Secret Whales,team-tsw,0,2,11200',
    'mvk-2,2026-06-05,2026,LCP,Split 2,0,16.11,team,Blue,,team-mvk,MVK Esports,team-mvk,1,19,65500',
    'mvk-2,2026-06-05,2026,LCP,Split 2,0,16.11,team,Red,,team-tsw,Team Secret Whales,team-tsw,0,9,57100',
    'mvk-2,2026-06-05,2026,LCP,Split 2,0,16.11,top,Blue,Kratos,oe:player:75019a36fdf85666fbd9396ae4fc7ec,MVK Esports,team-mvk,1,6,13200',
    'mvk-2,2026-06-05,2026,LCP,Split 2,0,16.11,top,Red,Hasmed,oe:player:hasmed,Team Secret Whales,team-tsw,0,1,10900',
  ].join('\n'))

  const firstNewMeta = result.matches.find((match) => match.sourceGameId === 'new-meta-1')
  const secondNewMeta = result.matches.find((match) => match.sourceGameId === 'new-meta-2')
  const firstMvk = result.matches.find((match) => match.sourceGameId === 'mvk-1')
  const secondMvk = result.matches.find((match) => match.sourceGameId === 'mvk-2')
  const firstNewMetaTop = firstNewMeta?.teamARoster?.players[0]
  const secondNewMetaTop = secondNewMeta?.teamARoster?.players[0]
  const firstMvkTop = firstMvk?.teamARoster?.players[0]
  const secondMvkTop = secondMvk?.teamARoster?.players[0]
  const unrelatedSameHandle = firstNewMeta?.teamBRoster?.players[0]

  assert.equal(firstNewMetaTop?.id, 'oe:player:0a86dddc699c7e6fe7f1e43153a5cbe')
  assert.equal(secondNewMetaTop?.id, 'oe:player:0a86dddc699c7e6fe7f1e43153a5cbe')
  assert.equal(firstMvkTop?.id, 'oe:player:75019a36fdf85666fbd9396ae4fc7ec')
  assert.equal(secondMvkTop?.id, 'oe:player:75019a36fdf85666fbd9396ae4fc7ec')
  assert.equal(unrelatedSameHandle?.id, 'oe:player:unrelated-same-handle')
})

test('Oracle import marks incomplete player rows as a partial roster', () => {
  const result = importOraclesElixirCsv([
    'gameid,date,year,league,split,playoffs,patch,position,side,playername,playerid,teamname,teamid,result,kills,totalgold',
    'oe-partial-1,2026-01-01,2026,LCK,Spring,0,26.1,team,Blue,,team-blue,T1,team-t1,1,20,65000',
    'oe-partial-1,2026-01-01,2026,LCK,Spring,0,26.1,team,Red,,team-red,Gen.G,team-gen,0,12,59000',
    'oe-partial-1,2026-01-01,2026,LCK,Spring,0,26.1,top,Blue,Zeus,p-top,T1,team-t1,1,4,12000',
    'oe-partial-1,2026-01-01,2026,LCK,Spring,0,26.1,jng,Blue,Oner,p-jng,T1,team-t1,1,3,11000',
  ].join('\n'))

  assert.equal(result.matches[0]?.teamARoster?.completeness, 'partial')
  assert.equal(result.matches[0]?.teamBRoster, undefined)
})

test('Oracle import scopes missing player ids to the unresolved source team', () => {
  const result = importOraclesElixirCsv([
    'gameid,date,year,league,split,playoffs,patch,position,side,playername,playerid,teamname,teamid,result,kills,totalgold',
    'oe-missing-player-1,2026-01-01,2026,LCK,Spring,0,26.1,team,Blue,,,T1,team-t1,1,20,65000',
    'oe-missing-player-1,2026-01-01,2026,LCK,Spring,0,26.1,team,Red,,,Gen.G,team-gen,0,12,59000',
    'oe-missing-player-1,2026-01-01,2026,LCK,Spring,0,26.1,top,Blue,Shared Handle,,T1,team-t1,1,4,12000',
    'oe-missing-player-1,2026-01-01,2026,LCK,Spring,0,26.1,top,Red,Shared Handle,,Gen.G,team-gen,0,2,11000',
    'oe-missing-player-2,2026-01-02,2026,LCK,Spring,0,26.1,team,Blue,,,T1,team-t1,1,20,65000',
    'oe-missing-player-2,2026-01-02,2026,LCK,Spring,0,26.1,team,Red,,,Dplus Kia,team-dk,0,12,59000',
    'oe-missing-player-2,2026-01-02,2026,LCK,Spring,0,26.1,top,Blue,Shared Handle,,T1,team-t1,1,4,12000',
  ].join('\n'))
  const [first, second] = result.matches
  const t1First = first?.teamARoster?.players[0]
  const genFirst = first?.teamBRoster?.players[0]
  const t1Second = second?.teamARoster?.players[0]

  assert.ok(t1First?.id.startsWith('oe:player:unresolved:'))
  assert.equal(t1First?.name, 'Shared Handle')
  assert.notEqual(t1First?.id, genFirst?.id)
  assert.equal(t1First?.id, t1Second?.id)
})

function matchFixture(overrides: Partial<MatchRecord>): MatchRecord {
  return {
    id: 'fixture',
    sourceProvider: 'seed',
    sourceGameId: 'fixture',
    dataCompleteness: 'scoreboard-game-stats',
    date: '2026-01-01',
    season: 2026,
    event: 'LCK 2026 Spring',
    phase: 'Regular season',
    region: 'LCK',
    league: 'LCK',
    teamAHomeLeague: 'LCK',
    teamBHomeLeague: 'LCK',
    teamARegion: 'LCK',
    teamBRegion: 'LCK',
    patch: '26.1',
    bestOf: 3,
    tier: 'regional-regular',
    teamA: 'T1',
    teamB: 'Gen.G',
    winner: 'T1',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
    ...overrides,
  }
}
