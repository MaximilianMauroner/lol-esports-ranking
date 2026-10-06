import type { TeamStanding } from '../../src/types'
import { matchLevelEligibilityHistory } from '../../src/lib/eligibility'
import { initialTeamRating } from '../../src/lib/modelConfig'
import { evidenceWeightedPublishedLeagueAnchor, evidenceWeightedPublishedStanding, publishedLeagueAnchorContextAdjustment, publishedRosterPriorOffset, publishedTeamStableOffset, ratingComponents, ratingFromComponents } from '../../src/lib/ratingCalculations'

export const boardLayerNames = ['current', 'noCompression', 'noAnchorRelief', 'noSparseBlend', 'noRosterCap', 'noHeadToHead', 'noAnchorShrinkage', 'spine'] as const

export function ablatedBoardRating(standing: TeamStanding, rawRoster: number, headToHead: number,
  layer: typeof boardLayerNames[number], integerStandingScores = false) {
  const count = matchLevelEligibilityHistory(standing.history).length
  const league = layer === 'noAnchorShrinkage' ? standing.leagueScore : evidenceWeightedPublishedLeagueAnchor(standing.leagueScore, count)
  const roster = layer === 'noRosterCap' ? rawRoster : publishedRosterPriorOffset(rawRoster, standing.wins, standing.losses)
  const relief = layer === 'noAnchorRelief' ? 0 : publishedLeagueAnchorContextAdjustment({ leagueScore: league, teamRating: standing.baseRating,
    wins: standing.wins, losses: standing.losses, uncertainty: standing.uncertainty, rosterBasis: standing.rosterBasis })
  const context = relief + (layer === 'noHeadToHead' ? 0 : headToHead)
  const components = ratingComponents({ teamRating: standing.baseRating, leagueScore: league, rosterPriorOffset: roster,
    momentum: standing.ratingComponents.momentum, contextAdjustment: context, uncertainty: standing.uncertainty })
  if (layer === 'noCompression') components.teamStableOffset = standing.baseRating - initialTeamRating
  const raw = ratingFromComponents(components)
  const blended = layer === 'noSparseBlend' ? raw : evidenceWeightedPublishedStanding(raw, standing.history.at(-1)?.rating, count)
  const final = ratingComponents({ teamRating: standing.baseRating, leagueScore: league, rosterPriorOffset: roster,
    momentum: standing.ratingComponents.momentum, contextAdjustment: context + blended - raw, uncertainty: standing.uncertainty })
  if (layer === 'noCompression') final.teamStableOffset = standing.baseRating - initialTeamRating
  const score = ratingFromComponents(final)
  const formatted = integerStandingScores ? Math.round(score) : score
  if (layer === 'current' && Math.abs(formatted - standing.rating) > 1e-8) throw new Error('Public board composition mismatch')
  if (layer === 'spine') return standing.baseRating + standing.leagueScore - initialTeamRating + rawRoster + standing.ratingComponents.momentum
  return formatted
}
