export type Region = 'LCK' | 'LPL' | 'LEC' | 'LCS' | 'LCP' | 'CBLOL' | 'VCS' | 'PCS' | 'International'

export type EventTier =
  | 'worlds-playoffs'
  | 'worlds-main'
  | 'msi-bracket'
  | 'msi-play-in'
  | 'major-playoffs'
  | 'regional-regular'
  | 'minor-international'
  | 'qualifier'

export type Role = 'Top' | 'Jungle' | 'Mid' | 'Bot' | 'Support'
export type Side = 'blue' | 'red'

export type PlayerImpactSignals = {
  objectiveImpactZ?: number
  awardResidualZ?: number
  recentFormZ?: number
  availability?: number
  roleCertainty?: number
}

export type SourceTrace = {
  provider?: MatchRecord['sourceProvider']
  gameId?: string
  matchId?: string
  url?: string
  fileName?: string
  completeness?: string
}

export type TeamProfile = {
  name: string
  code: string
  region: Region
  league: string
}

export type PlayerProfile = {
  id: string
  name: string
  team: string
  role: Role
  impactSignals?: PlayerImpactSignals
}

export type MatchRecord = {
  id: string
  sourceProvider?: 'oracles-elixir' | 'leaguepedia-cargo' | 'riot-gpr' | 'seed'
  sourceGameId?: string
  sourceMatchId?: string
  sourceUrl?: string
  sourceFileName?: string
  dataCompleteness?: string
  date: string
  season: number
  event: string
  phase: string
  region: Region
  league: string
  teamAHomeLeague?: string
  teamBHomeLeague?: string
  teamARegion?: Region
  teamBRegion?: Region
  teamASide?: Side
  teamBSide?: Side
  patch: string
  bestOf: number
  tier: EventTier
  teamA: string
  teamB: string
  winner: string
  teamAKills: number
  teamBKills: number
  teamAGold: number
  teamBGold: number
  teamATowers?: number
  teamBTowers?: number
  teamADragons?: number
  teamBDragons?: number
  teamABarons?: number
  teamBBarons?: number
  gameLengthSeconds?: number
}

export type TeamHistoryPoint = {
  date: string
  event: string
  opponent: string
  rating: number
  baseRating: number
  leagueAdjustment: number
  sideAdjustment: number
  rank: number
  delta: number
  tier: EventTier
  result: 'W' | 'L'
  source: SourceTrace
}

export type FactorBreakdown = {
  context: number
  recency: number
  execution: number
  opponent: number
  league: number
}

export type LeagueStrength = {
  league: string
  region: Region
  score: number
  adjustment: number
  delta: number
  wins: number
  losses: number
  internationalMatches: number
  form: string[]
  lastEvent?: string
  lastUpdated?: string
}

export type TeamStanding = {
  team: string
  code: string
  region: Region
  league: string
  baseRating: number
  leagueScore: number
  leagueAdjustment: number
  leagueDelta: number
  rating: number
  previousRating: number
  delta: number
  rank: number
  previousRank: number
  movement: number
  wins: number
  losses: number
  confidence: number
  uncertainty: number
  form: string[]
  strongestFactor: keyof FactorBreakdown
  factors: FactorBreakdown
  history: TeamHistoryPoint[]
  recentEvents: string[]
}

export type PlayerStanding = {
  id: string
  name: string
  team: string
  role: Role
  rating: number
  delta: number
  rank: number
  baseShare: number
  playerShare: number
  impactMultiplier: number
  availability: number
  roleCertainty: number
  impactDrivers: {
    objectiveImpactZ: number
    awardResidualZ: number
    recentFormZ: number
  }
  form: string[]
  history: {
    date: string
    event: string
    rating: number
    delta: number
  }[]
}

export type EventSummary = {
  event: string
  season: number
  tier: EventTier
  region: Region
  matches: number
  ratingImpact: number
  topTeams: string[]
  startDate: string
  endDate: string
  sourceBreakdown: {
    provider: string
    matchCount: number
  }[]
}

export type SeasonSummary = {
  season: number
  matches: number
  events: number
  topTeam: string
  mostImproved: string
  startDate: string
  endDate: string
}
