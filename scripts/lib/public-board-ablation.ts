import type { TeamStanding } from '../../src/types'
import { matchLevelEligibilityHistory } from '../../src/lib/eligibility'
import { initialTeamRating } from '../../src/lib/modelConfig'
import { evidenceWeightedPublishedLeagueAnchor, evidenceWeightedPublishedStanding, publishedLeagueAnchorContextAdjustment, publishedRosterPriorOffset, ratingComponents, ratingFromComponents } from '../../src/lib/ratingCalculations'

export const boardLayerNames = ['current', 'noCompression', 'noAnchorRelief', 'noSparseBlend', 'noRosterCap', 'noHeadToHead', 'noAnchorShrinkage', 'spine'] as const

export type BoardState = { teamRating: number; leagueScore: number; rosterOffset: number; momentum: number; uncertainty: number; headToHead: number }

export function ablatedBoardRating(standing: TeamStanding, rawState: BoardState,
  layer: typeof boardLayerNames[number], integerStandingScores = true) {
  const count = matchLevelEligibilityHistory(standing.history).length
  const league = layer === 'noAnchorShrinkage' ? rawState.leagueScore : evidenceWeightedPublishedLeagueAnchor(rawState.leagueScore, count)
  const roster = layer === 'noRosterCap' ? rawState.rosterOffset : publishedRosterPriorOffset(rawState.rosterOffset, standing.wins, standing.losses)
  const relief = layer === 'noAnchorRelief' ? 0 : publishedLeagueAnchorContextAdjustment({ leagueScore: league, teamRating: rawState.teamRating,
    wins: standing.wins, losses: standing.losses, uncertainty: rawState.uncertainty, rosterBasis: standing.rosterBasis })
  const context = relief + (layer === 'noHeadToHead' ? 0 : rawState.headToHead)
  const components = ratingComponents({ teamRating: rawState.teamRating, leagueScore: league, rosterPriorOffset: roster,
    momentum: rawState.momentum, contextAdjustment: context, uncertainty: rawState.uncertainty })
  if (layer === 'noCompression') components.teamStableOffset = rawState.teamRating - initialTeamRating
  const raw = ratingFromComponents(components)
  const blended = layer === 'noSparseBlend' ? raw : evidenceWeightedPublishedStanding(raw, standing.history.at(-1)?.rating, count)
  const final = ratingComponents({ teamRating: rawState.teamRating, leagueScore: league, rosterPriorOffset: roster,
    momentum: rawState.momentum, contextAdjustment: context + blended - raw, uncertainty: rawState.uncertainty })
  if (layer === 'noCompression') final.teamStableOffset = rawState.teamRating - initialTeamRating
  const score = ratingFromComponents(final)
  const formatted = integerStandingScores ? Math.round(score) : score
  if (layer === 'current' && Math.abs(formatted - standing.rating) > 1e-8) throw new Error('Public board composition mismatch')
  if (layer === 'spine') return rawState.teamRating + rawState.leagueScore - initialTeamRating + rawState.rosterOffset + rawState.momentum
  return formatted
}
