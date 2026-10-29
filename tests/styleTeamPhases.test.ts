import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildStyleProfiles } from '../src/domains/style/build.ts'
import { buildStyleCohorts, styleMeasures } from '../src/domains/style/profile.ts'
import { StyleTeamPhases } from '../src/views/style/StyleTeamPhases.tsx'
import { styleGame } from './styleProfileFixtures.ts'

test('early game evidence keeps its gold value and sample when measures change order', () => {
  const scope = buildStyleProfiles(Array.from({ length: 20 }, (_, i) => styleGame(String(i))), 'a'.repeat(64)).scopes.all
  const team = scope.teams[0]
  const measures = styleMeasures(team, buildStyleCohorts(scope.teams)).map(measure => measure.metric.key === 'fullTeamGoldDiffAt15'
    ? { ...measure, value: 731, games: 18 }
    : measure).reverse()
  const html = renderToStaticMarkup(createElement(StyleTeamPhases, { teams: [team], measures: [measures] }))
  assert.match(html, /\+731 gold\. 18 of 20 games\./)
})
