import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RegionDepthChart } from '../src/components/RegionDepthChart.tsx'

function dotCentre(html: string, team: string) {
  const match = html.match(new RegExp(`aria-label="${team}, [^"]*"[^>]*><circle cx="([\\d.]+)" cy="([\\d.]+)"`))
  assert.ok(match, `no dot for ${team}`)
  return { x: Number(match[1]), y: Number(match[2]) }
}

test('the lead dot keeps the line under the lead label when a weaker scoring dot collides', () => {
  // One Power point apart, the two strongest dots overlap at the default width.
  const html = renderToStaticMarkup(createElement(RegionDepthChart, {
    regions: [{
      region: 'LCK',
      rank: 1,
      score: 1966,
      internationalWins: 0,
      internationalLosses: 0,
      topTeams: [
        { team: 'Gen.G', code: 'GEN', rating: 2000, rank: 1 },
        { team: 'Hanwha Life Esports', code: 'HLE', rating: 1999, rank: 2 },
        { team: 'T1', code: 'T1', rating: 1900, rank: 3 },
      ],
    }],
  }))

  const line = html.match(/<line x1="[\d.]+" x2="[\d.]+" y1="([\d.]+)" y2="[\d.]+" stroke="var\(--line-strong\)"/)
  const label = html.match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>GEN<\/text>/)
  assert.ok(line && label)
  const lineY = Number(line[1])
  const lead = dotCentre(html, 'Gen.G')
  const runnerUp = dotCentre(html, 'Hanwha Life Esports')

  assert.equal(lead.y, lineY, 'the lead dot should keep the line')
  assert.notEqual(runnerUp.y, lineY, 'the weaker dot should move off the line')
  assert.equal(Number(label[1]), lead.x)
  assert.ok(Number(label[2]) < lead.y)
})
