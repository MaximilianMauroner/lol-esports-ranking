import type { EventTier } from '../types'

export const preseasonEventWeightPolicy = 'post-worlds-before-next-calendar-year-discount-v1'
export const preseasonEventWeightMultiplier = 0.35
export const preseasonEventWeightWindow = 'after latest Worlds match in a calendar year and before Jan 1 of the next calendar year'

export const eventTierConfig: Record<
  EventTier,
  {
    label: string
    kFactor: number
    leagueKFactor: number
    weight: number
    description: string
  }
> = {
  'worlds-playoffs': {
    label: 'Worlds playoffs',
    kFactor: 34,
    leagueKFactor: 24,
    weight: 34 / 14,
    description: 'Highest leverage international knockout series and games.',
  },
  'worlds-main': {
    label: 'Worlds main stage',
    kFactor: 24,
    leagueKFactor: 18,
    weight: 24 / 14,
    description: 'World Championship games before the final bracket peak.',
  },
  'msi-bracket': {
    label: 'MSI bracket',
    kFactor: 34,
    leagueKFactor: 24,
    weight: 34 / 14,
    description: 'International bracket games with current-season regional champions.',
  },
  'msi-play-in': {
    label: 'MSI play-in',
    kFactor: 24,
    leagueKFactor: 18,
    weight: 24 / 14,
    description: 'International qualification games with meaningful cross-region signal.',
  },
  'major-playoffs': {
    label: 'Major regional playoffs',
    kFactor: 22,
    leagueKFactor: 0,
    weight: 22 / 14,
    description: 'Domestic playoff games with Worlds/MSI qualification pressure.',
  },
  'regional-regular': {
    label: 'Regional regular season',
    kFactor: 14,
    leagueKFactor: 0,
    weight: 1,
    description: 'High-volume domestic games, useful but less decisive alone.',
  },
  'minor-international': {
    label: 'Minor international',
    kFactor: 20,
    leagueKFactor: 12,
    weight: 20 / 14,
    description: 'Cross-region events below MSI and Worlds in global signal strength.',
  },
  qualifier: {
    label: 'Qualifier',
    kFactor: 12,
    leagueKFactor: 0,
    weight: 12 / 14,
    description: 'Qualification matches with stakes but often narrower fields.',
  },
}

export const modelFactors = [
  {
    key: 'context',
    label: 'Context of play',
    description: 'Worlds playoffs count more than MSI, playoffs, and regular season; post-Worlds preseason games are discounted.',
  },
  {
    key: 'recency',
    label: 'Recent performance',
    description: 'Newer matches decay more slowly into the current snapshot.',
  },
  {
    key: 'execution',
    label: 'Result signal',
    description: 'Team Elo uses win/loss only; kills, gold, and objectives are not team-rating multipliers in this version.',
  },
  {
    key: 'opponent',
    label: 'Opponent strength',
    description: 'Beating a strong opponent moves the model more than beating a weak one.',
  },
  {
    key: 'league',
    label: 'League strength',
    description: 'International results update league Elo, which is blended into each team power rating.',
  },
] as const
