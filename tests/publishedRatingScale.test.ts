import assert from 'node:assert/strict'
import test from 'node:test'
import { minimumUncertainty, publishedRatingScale } from '../src/lib/modelConfig.ts'
import { estimateMatchupProbability } from '../src/lib/matchupMath.ts'
import { estimatePublicMatchup } from '../src/lib/publicMatchup.ts'
import {
  toInternalRating,
  toInternalRatingDelta,
  toPublishedRating,
  toPublishedRatingComponents,
  toPublishedRatingDelta,
} from '../src/lib/ratingCalculations.ts'
import { createStaticRankingData, createStaticRankingSummaryData, createTeamHistoryArtifacts } from '../src/lib/snapshot.ts'
import { toPublishedRegionStrength } from '../src/lib/publishedRatingArtifacts.ts'
import type { RegionStrength } from '../src/lib/regionStrength.ts'
import { sampleMatches, teams } from './fixtures/rankingFixtures.ts'

test('published rating scale is monotonic, invertible, and scales deltas', () => {
  assert.equal(toPublishedRating(1500), 1800)
  assert.equal(toPublishedRatingDelta(20), 65)
  assert.equal(toInternalRating(toPublishedRating(1660)), 1660)
  assert.ok(toPublishedRating(1660) > toPublishedRating(1600))
  assert.equal(toPublishedRating(600), publishedRatingScale.publishedMinimum)
  assert.equal(toPublishedRating(2200), publishedRatingScale.publishedMaximum)
})

test('minimum model uncertainty publishes as a compact rating band', () => {
  assert.equal(toPublishedRatingDelta(minimumUncertainty), 65)
})

test('published rating components reconcile with transformed rating', () => {
  const components = {
    leagueAnchor: 1512,
    teamStableOffset: 48,
    rosterPriorOffset: 4.5,
    momentum: 3.5,
    contextAdjustment: -2,
    uncertainty: 44,
  }
  const published = toPublishedRatingComponents(components)

  assert.equal(published.leagueAnchor, Math.round(toPublishedRating(components.leagueAnchor)))
  assert.equal(published.teamStableOffset, 156)
  assert.equal(published.rosterPriorOffset, 14.6)
  assert.equal(published.momentum, 11.4)
  assert.equal(published.contextAdjustment, -6.5)
  assert.equal(published.uncertainty, 143)
})

test('public summary publishes ladder-scale ratings while internal snapshots remain calibrated', () => {
  const data = rankingDataFixture()
  const { manifest, snapshots } = createStaticRankingSummaryData(data)
  const internalSnapshot = data.snapshots[data.defaultSnapshotKey]
  const publicSnapshot = snapshots[data.defaultSnapshotKey]
  const internalRows = internalSnapshot.standings
  const publicRows = publicSnapshot.standings
  const internalLeader = internalRows[0]
  const publicLeader = publicRows[0]

  assert.ok(internalLeader)
  assert.ok(publicLeader)
  assert.deepEqual(manifest.ratingScale, publishedRatingScale)
  assert.deepEqual(publicSnapshot.ratingScale, publishedRatingScale)
  assert.equal(publicLeader.team, internalLeader.team)
  assert.equal(publicLeader.rating, Math.round(toPublishedRating(internalLeader.rating)))
  assert.equal(publicLeader.previousRating, Math.round(toPublishedRating(internalLeader.previousRating)))
  assert.equal(publicLeader.delta, publicLeader.rating - publicLeader.previousRating)
  assert.equal(publicLeader.uncertainty, Math.round(toPublishedRatingDelta(internalLeader.uncertainty)))
  assert.equal(publicRows.map((standing) => standing.team).join('|'), internalRows.map((standing) => standing.team).join('|'))
  assert.ok(publicLeader.rating > internalLeader.rating)
  assert.equal(publicSnapshot.leagues[0]?.score, Math.round(toPublishedRating(internalSnapshot.leagues[0]?.score ?? 1500)))
  const publicRegion = publicSnapshot.regions[0]
  assert.ok(publicRegion)
  if (publicRegion.topTeams.length > 0) {
    assert.equal(publicRegion.score, averageRating(publicRegion.topTeams.slice(0, 3)))
  } else {
    assert.equal(publicRegion.score, Math.round(toPublishedRating(internalSnapshot.regions[0]?.score ?? 1500)))
  }
})

test('published region strength averages published top-three representative scores', () => {
  const publicScores = [1851.6, 1698.6, 1598.6]
  const internalScores = publicScores.map((rating) => toInternalRating(rating, publishedRatingScale))
  const region = regionStrengthFixture({
    score: averageRaw(internalScores),
    topTeamRating: internalScores[0],
    topThreeTeamRating: averageRaw(internalScores),
    totalTeamRating: averageRaw(internalScores),
    topTeams: [
      { team: 'Team Secret Whales', code: 'TSW', rating: internalScores[0], rank: 19 },
      { team: 'Deep Cross Gaming', code: 'DCG', rating: internalScores[1], rank: 32 },
      { team: 'GAM Esports', code: 'GAM', rating: internalScores[2], rank: 39 },
    ],
    deservedStanding: {
      rank: 4,
      score: averageRaw(internalScores) + 10,
      rankDeltaFromPower: 1,
      scoreDeltaFromPower: 10,
      internationalResumePoints: 4,
      seedPerformancePoints: 3,
      stagePoints: 3,
      seedPerformanceRate: 0.5,
      internationalWinsAboveExpectation: 1,
      connectivity: 0.8,
    },
  })

  const published = toPublishedRegionStrength(region, publishedRatingScale)

  assert.deepEqual(published.topTeams.map((team) => team.rating), [1852, 1699, 1599])
  assert.equal(published.score, 1717)
  assert.equal(published.topThreeTeamRating, 1717)
  assert.equal(published.deservedStanding?.scoreDeltaFromPower, (published.deservedStanding?.score ?? 0) - published.score)
})

test('published team history exposes current standing separately from the final match point', () => {
  const data = rankingDataFixture()
  const { snapshots } = createStaticRankingSummaryData(data)
  const history = createTeamHistoryArtifacts(data)
  const publicSnapshot = snapshots[data.defaultSnapshotKey]
  const standing = publicSnapshot.standings.find((row) => history.shards[data.defaultSnapshotKey].series[row.teamId])

  assert.ok(standing)
  const series = history.shards[data.defaultSnapshotKey].series[standing.teamId]
  const finalPoint = series?.points.at(-1)
  const currentStanding = series?.currentStanding

  assert.deepEqual(history.index.ratingScale, publishedRatingScale)
  assert.deepEqual(history.shards[data.defaultSnapshotKey].ratingScale, publishedRatingScale)
  assert.ok(finalPoint)
  assert.ok(currentStanding)
  assert.equal(currentStanding.rating, standing.rating)
  assert.equal(currentStanding.rank, standing.rank)
  assert.equal(currentStanding.lastMatchRating, finalPoint[1])
  assert.equal(currentStanding.adjustment, standing.rating - finalPoint[1])
})

test('public matchup estimates invert ladder ratings before probability math', () => {
  const data = rankingDataFixture()
  const { manifest, snapshots } = createStaticRankingSummaryData(data)
  const internalRows = data.snapshots[data.defaultSnapshotKey].standings
  const publicRows = snapshots[data.defaultSnapshotKey].standings
  const internalHome = internalRows[0]
  const internalAway = internalRows[1]
  const publicHome = publicRows.find((standing) => standing.team === internalHome?.team)
  const publicAway = publicRows.find((standing) => standing.team === internalAway?.team)

  assert.ok(internalHome)
  assert.ok(internalAway)
  assert.ok(publicHome)
  assert.ok(publicAway)

  const publicInputEstimate = estimateMatchupProbability(
    {
      team: publicHome.team,
      rating: toInternalRating(publicHome.rating, manifest.ratingScale),
      uncertainty: toInternalRatingDelta(publicHome.uncertainty, manifest.ratingScale),
    },
    {
      team: publicAway.team,
      rating: toInternalRating(publicAway.rating, manifest.ratingScale),
      uncertainty: toInternalRatingDelta(publicAway.uncertainty, manifest.ratingScale),
    },
    { bestOf: 5 },
  )
  const publicEstimate = estimatePublicMatchup(publicHome, publicAway, manifest.model, { bestOf: 5 })

  assert.equal(publicEstimate.homeGameWinProbability, publicInputEstimate.teamAGameWinProbability)
  assert.equal(publicEstimate.homeSeriesWinProbability, publicInputEstimate.teamASeriesWinProbability)
  const internalEstimate = estimateMatchupProbability(
    { team: internalHome.team, rating: internalHome.rating, uncertainty: internalHome.uncertainty },
    { team: internalAway.team, rating: internalAway.rating, uncertainty: internalAway.uncertainty },
    { bestOf: 5 },
  )
  assert.ok(Math.abs(publicEstimate.homeGameWinProbability - internalEstimate.teamAGameWinProbability) <= 0.0002)
  assert.equal(publicEstimate.ratingEdge, publicHome.rating - publicAway.rating)
})

function rankingDataFixture() {
  return createStaticRankingData({
    matches: sampleMatches,
    teams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
}

function regionStrengthFixture(overrides: Partial<RegionStrength> = {}): RegionStrength {
  return {
    region: 'LCP',
    rank: 5,
    score: 1500,
    topTeamRating: 1500,
    topThreeTeamRating: 1500,
    totalTeamRating: 1500,
    teamCount: 3,
    ecosystemTeamCount: 3,
    leagueCount: 1,
    ecosystemLeagueCount: 1,
    flagshipLeagues: ['LCP'],
    connectivity: 0.8,
    internationalWins: 0,
    internationalLosses: 0,
    flagshipLeague: 'LCP',
    tier: 'tier-two',
    topTeams: [],
    ...overrides,
  }
}

function averageRating(values: readonly { rating: number }[]) {
  return Math.round(averageRaw(values.map((value) => value.rating)))
}

function averageRaw(values: readonly number[]) {
  assert.ok(values.length > 0)
  return values.reduce((total, value) => total + value, 0) / values.length
}
