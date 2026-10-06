import type { EventTier } from '../types'

export const preseasonEventWeightPolicy = 'completed-worlds-offseason-except-domestic-season-and-demacia-v3'
export const preseasonEventWeightMultiplier = 0.35
export const preseasonEventWeightWindow = 'after a resolved Worlds best-of-five final and before Jan 1 of the next calendar year; domestic season games and Demacia Cup are exempt'
export const firstStandPowerEvidencePolicy = 'full-champion-field-at-msi-bracket-weight-v1'

export const eventTierConfig: Record<
  EventTier,
  {
    label: string
    kFactor: number
    weight: number
    description: string
  }
> = {
  'worlds-playoffs': {
    label: 'Worlds playoffs',
    kFactor: 39,
    weight: 39 / 14,
    description: 'Highest leverage international knockout series and games.',
  },
  'worlds-main': {
    label: 'Worlds main stage',
    kFactor: 27,
    weight: 27 / 14,
    description: 'World Championship games before the final bracket peak.',
  },
  'msi-bracket': {
    label: 'MSI / First Stand knockout',
    kFactor: 34,
    weight: 34 / 14,
    description: 'MSI and First Stand knockout games, below the Worlds playoff evidence weight.',
  },
  'msi-play-in': {
    label: 'MSI / First Stand early stages',
    kFactor: 27,
    weight: 27 / 14,
    description: 'MSI play-in evidence; First Stand early stages use the full champion-field Power weight.',
  },
  'major-playoffs': {
    label: 'Major regional playoffs',
    kFactor: 22,
    weight: 22 / 14,
    description: 'Domestic playoff games with Worlds/MSI qualification pressure.',
  },
  'regional-regular': {
    label: 'Regional regular season',
    kFactor: 14,
    weight: 1,
    description: 'High-volume domestic games, useful but less decisive alone.',
  },
  'minor-international': {
    label: 'Regional cups and minor international',
    kFactor: 23,
    weight: 23 / 14,
    description: 'Demacia Cup and cross-region events below MSI and Worlds in global signal strength.',
  },
  qualifier: {
    label: 'Qualifier',
    kFactor: 12,
    weight: 12 / 14,
    description: 'Qualification matches with stakes but often narrower fields.',
  },
}

export const modelFactors = [
  {
    key: 'context',
    label: 'Context of play',
    description: 'Worlds playoffs count more than MSI, playoffs, and regular season; post-Worlds preseason games are discounted except Demacia Cup.',
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
