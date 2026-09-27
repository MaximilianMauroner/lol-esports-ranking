import assert from 'node:assert/strict'
import test from 'node:test'
import { boardHeadline } from '../src/lib/boardHeadline.ts'
import { publishedRatingScale } from '../src/lib/modelConfig.ts'
import { isNearTie, nearTieGroups, nearTiePositions } from '../src/lib/nearTies.ts'
import type { RankingSummaryStanding } from '../src/lib/snapshot.ts'

const model = { version: 'model-v1', configHash: 'hash-v1', ratingScale: publishedRatingScale }

test('a gap inside the uncertainty is a near tie and a large gap is not', () => {
  assert.equal(isNearTie(standing('HLE', 2304), standing('BLG', 2275), model), true)
  assert.equal(isNearTie(standing('BLG', 2275), standing('GEN', 2138), model), false)
})

test('near-tie groups hold teams within reach of the group leader, not a chain of small gaps', () => {
  const rows = [standing('A', 2300), standing('B', 2290), standing('C', 2150), standing('D', 2140), standing('E', 2130), standing('F', 1900)]
  const groups = nearTieGroups(rows, model)
  assert.deepEqual(groups.map((group) => group.map((row) => row.code)), [['A', 'B'], ['C', 'D', 'E'], ['F']])

  // Every neighbour gap is 30 points, but the ends are 120 apart.
  const ladder = [standing('P', 2120), standing('Q', 2090), standing('R', 2060), standing('S', 2030), standing('T', 2000)]
  assert.deepEqual(nearTieGroups(ladder, model).map((group) => group.map((row) => row.code)), [['P', 'Q'], ['R', 'S'], ['T']])

  const positions = nearTiePositions(groups, (row) => row.code)
  assert.deepEqual(Object.fromEntries(positions), { A: 'start', B: 'end', C: 'start', D: 'middle', E: 'end' })
})

test('headline calls a coin-flip lead close to level', () => {
  const headline = boardHeadline([standing('Hanwha Life Esports', 2304), standing('Bilibili Gaming', 2275)], model)
  assert.match(headline?.headline ?? '', /^Hanwha Life Esports lead, but Bilibili Gaming are close to level: 5\d% per game\.$/)
})

test('headline states a clear lead as a points gap and game edge', () => {
  const headline = boardHeadline([standing('Alpha', 2400), standing('Beta', 2200)], model)
  assert.match(headline?.headline ?? '', /^Alpha lead Beta by 200 points, a \d\d% game edge\.$/)
})

test('headline details name exact ties and long near-tie runs', () => {
  const ranked = [
    standing('Leader', 2500),
    standing('Gen.G', 2300),
    standing('T1', 2300),
    standing('LYON', 2100),
    standing('AL', 2090),
    standing('KT', 2080),
    standing('TSW', 2070),
    standing('Last', 1800),
  ]
  assert.deepEqual(boardHeadline(ranked, model)?.details, [
    'Gen.G and T1 are tied at 2,300.',
    '4 teams from LYON to TSW sit within 30 points, so one series can reorder them.',
  ])
})

test('headline handles scopes with one or no ranked team', () => {
  assert.equal(boardHeadline([], model), undefined)
  assert.deepEqual(boardHeadline([standing('Solo', 2000)], model), { headline: 'Solo lead the ranking.', details: [] })
})

function standing(team: string, rating: number): RankingSummaryStanding {
  return { team, code: team, rating, uncertainty: 65 } as RankingSummaryStanding
}
