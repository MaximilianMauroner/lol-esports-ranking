import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OpenRadarShape } from '../src/views/style/StyleRadar.tsx'
import { buildStyleCohorts, styleMeasures } from '../src/domains/style/profile.ts'
import { buildStyleProfiles } from '../src/domains/style/build.ts'
import { styleGame } from './styleProfileFixtures.ts'

const scope = buildStyleProfiles(Array.from({ length: 20 }, (_, i) => styleGame(String(i))), 'a'.repeat(64)).scopes.all
const measures = styleMeasures(scope.players[0], buildStyleCohorts(scope.players)).filter(m => m.metric.axis)
const points = measures.map((_, i) => ({ x: 10 + i, y: 20 + i, angle: i }))
function render(rows: typeof measures) {
  return renderToStaticMarkup(createElement('svg', {}, createElement(OpenRadarShape, { points, measures: rows, selected: rows[0].metric.key, series: 'a' })))
}

test('complete radar closes and fills; missing axes have no point and only neighboring present segments', () => {
  const complete = render(measures)
  assert.match(complete, /data-closed="true"/)
  assert.match(complete, / Z/)
  assert.equal((complete.match(/<circle/g) ?? []).length, 8)
  const partial = measures.map((m, i) => i === 1 ? { ...m, status: 'missing' as const, percentile: null, value: null, games: 0 } : m)
  const open = render(partial)
  assert.match(open, /data-closed="false"/)
  assert.match(open, /fill="none"/)
  assert.doesNotMatch(open, / Z/)
  assert.doesNotMatch(open, /cx="11"/)
  assert.doesNotMatch(open, /M10,20 L12,22/)
  assert.match(open, /M17,27 L10,20/)
  assert.equal((open.match(/<circle/g) ?? []).length, 7)
})

test('below-minimum entities and wholly unavailable metrics never draw a polygon or a centre substitute', () => {
  const small = { ...scope.players[0], games: 19 }
  const rows = styleMeasures(small, buildStyleCohorts(scope.players)).filter(m => m.metric.axis)
  const html = render(rows)
  assert.match(html, /data-closed="false"/)
  assert.match(html, /d=""/)
  assert.doesNotMatch(html, /<circle/)
  assert.equal(rows[0].value, 10)
  assert.equal(rows[0].percentile, null)
})
