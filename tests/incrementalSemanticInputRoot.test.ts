import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createIncrementalSemanticInputRoot,
  deriveRankingTemporalContext,
} from '../src/lib/incremental/semanticInputRoot.ts'

const matches = [{
  event: 'Worlds 2026',
  season: 2026,
  date: '2026-10-01',
  officialMatchId: 'worlds-1',
  tier: 'worlds-main' as const,
}]
const scheduleReferences = [{
  matchId: 'worlds-1',
  leagueName: 'Worlds',
  date: '2026-10-01',
  state: 'unstarted',
  retrievedAt: '2026-10-01T12:00:00.000Z',
  coverageStart: '2026-09-20',
  coverageEnd: '2026-10-31',
  coverageEndComplete: true,
}, {
  matchId: 'worlds-final',
  leagueName: 'Worlds',
  date: '2026-10-31',
  state: 'unstarted',
  retrievedAt: '2026-10-01T12:00:00.000Z',
  coverageStart: '2026-09-20',
  coverageEnd: '2026-10-31',
  coverageEndComplete: true,
}]
const fixed = {
  matches,
  scheduleReferences,
  calendarHash: 'calendar',
  modelVersion: 'model',
  modelConfigHash: 'config',
}

test('semantic input root includes provider bytes and normalized temporal lifecycle boundaries', () => {
  const sameDayMorning = deriveRankingTemporalContext({ ...fixed, generatedAt: '2026-10-02T00:00:00.000Z' })
  const sameDayEvening = deriveRankingTemporalContext({ ...fixed, generatedAt: '2026-10-02T23:59:59.999Z' })
  const nextOngoingDay = deriveRankingTemporalContext({ ...fixed, generatedAt: '2026-10-03T00:00:00.000Z' })
  const staleSchedule = deriveRankingTemporalContext({ ...fixed, generatedAt: '2026-10-05T00:00:00.000Z' })

  assert.deepEqual(sameDayEvening, sameDayMorning)
  assert.equal(sameDayMorning.tournamentLifecycles[0]?.status, 'ongoing')
  assert.notDeepEqual(nextOngoingDay, sameDayMorning)
  assert.equal(staleSchedule.tournamentLifecycles[0]?.status, 'unknown')

  const base = createIncrementalSemanticInputRoot({
    providerRoot: 'provider-a',
    canonicalRoot: 'canonical',
    contextRoot: 'context',
    staticPlayerRoot: 'players',
    temporalContext: sameDayMorning,
  })
  const identicalBucket = createIncrementalSemanticInputRoot({
    providerRoot: 'provider-a',
    canonicalRoot: 'canonical',
    contextRoot: 'context',
    staticPlayerRoot: 'players',
    temporalContext: sameDayEvening,
  })
  const providerOnlyChange = createIncrementalSemanticInputRoot({
    providerRoot: 'provider-b',
    canonicalRoot: 'canonical',
    contextRoot: 'context',
    staticPlayerRoot: 'players',
    temporalContext: sameDayMorning,
  })
  const boundaryChange = createIncrementalSemanticInputRoot({
    providerRoot: 'provider-a',
    canonicalRoot: 'canonical',
    contextRoot: 'context',
    staticPlayerRoot: 'players',
    temporalContext: nextOngoingDay,
  })

  assert.equal(identicalBucket.inputRoot, base.inputRoot)
  assert.notEqual(providerOnlyChange.inputRoot, base.inputRoot)
  assert.notEqual(boundaryChange.inputRoot, base.inputRoot)
})
