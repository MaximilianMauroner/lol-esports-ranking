import assert from 'node:assert/strict'
import test from 'node:test'
import { publishedRatingScale } from '../src/lib/modelConfig.ts'
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
import { sampleMatches, teams } from './fixtures/rankingFixtures.ts'

test('published rating scale is monotonic, invertible, and scales deltas', () => {
  assert.equal(toPublishedRating(1500), 1800)
  assert.equal(toPublishedRatingDelta(20), 65)
  assert.equal(toInternalRating(toPublishedRating(1660)), 1660)
  assert.ok(toPublishedRating(1660) > toPublishedRating(1600))
  assert.equal(toPublishedRating(600), publishedRatingScale.publishedMinimum)
  assert.equal(toPublishedRating(2200), publishedRatingScale.publishedMaximum)
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
  assert.equal(publicSnapshot.regions[0]?.score, Math.round(toPublishedRating(internalSnapshot.regions[0]?.score ?? 1500)))
})

test('published team history final point reconciles to the published standing', () => {
  const data = rankingDataFixture()
  const { snapshots } = createStaticRankingSummaryData(data)
  const history = createTeamHistoryArtifacts(data)
  const publicSnapshot = snapshots[data.defaultSnapshotKey]
  const standing = publicSnapshot.standings.find((row) => history.shards[data.defaultSnapshotKey].series[row.teamId])

  assert.ok(standing)
  const series = history.shards[data.defaultSnapshotKey].series[standing.teamId]
  const finalPoint = series?.points.at(-1)

  assert.deepEqual(history.index.ratingScale, publishedRatingScale)
  assert.deepEqual(history.shards[data.defaultSnapshotKey].ratingScale, publishedRatingScale)
  assert.ok(finalPoint)
  assert.equal(finalPoint[1], standing.rating)
  assert.equal(finalPoint[2], standing.rank)
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
