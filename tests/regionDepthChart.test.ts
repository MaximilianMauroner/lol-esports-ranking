import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RegionDepthChart, regionDepthLayout } from '../src/components/RegionDepthChart.tsx'

function dotCentre(html: string, team: string) {
  const match = html.match(new RegExp(`data-team="${team}"><circle cx="([\\d.]+)" cy="([\\d.]+)"`))
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

for (const width of [320, 760]) {
  for (const ratings of [[2000, 2000, 2000, 2000], [2000, 1999.9, 1999.8, 1999.7, 1999.6, 1999.5]]) {
    test(`all clustered teams remain reachable with adjacent rows at width ${width}: ${ratings.length} teams`, () => {
      const regions = ['LCK', 'LPL'].map((region, index) => ({
        region,
        rank: index + 1,
        score: 2000,
        internationalWins: 0,
        internationalLosses: 0,
        topTeams: ratings.map((rating, teamIndex) => ({ team: `${region} ${teamIndex}`, code: `T${teamIndex}`, rating })),
      }))
      const layout = regionDepthLayout(regions, width)
      const allDots = layout.rows.flatMap((row) => row.dots.map((dot) => ({ ...dot, y: row.dotY + dot.dy })))
      for (const [index, dot] of allDots.entries()) {
        for (const other of allDots.slice(index + 1)) {
          assert.ok(Math.hypot(dot.x - other.x, dot.y - other.y) >= 18, `${dot.team} and ${other.team} have overlapping pointer targets`)
        }
      }
      for (const [index, row] of layout.rows.entries()) {
        const lead = row.dots.find((dot) => dot.regionalRank === 1)
        assert.ok(lead && row.lead)
        assert.equal(lead.dy, 0)
        assert.equal(row.lead.x, lead.x)
        assert.equal(row.lead.y, row.dotY - 11)
        assert.equal(row.dots.length, ratings.length)
        assert.deepEqual(row.dots.filter((dot) => dot.counts).map((dot) => dot.regionalRank).sort(), [1, 2, 3])
        const bottom = Math.max(...row.dots.map((dot) => row.dotY + dot.dy + 9))
        assert.ok(bottom < layout.axisLabelYs.at(-1)! - 10, 'targets must clear the bottom axis labels')
        assert.ok(bottom < layout.height, 'targets must stay inside the SVG')
        const next = layout.rows[index + 1]
        if (next) {
          const nextContentTop = layout.stacked ? next.labelY - 12 : next.lead!.y - 10
          assert.ok(bottom <= nextContentTop, 'targets must clear the next row labels')
        }
        if (layout.stacked) assert.ok(layout.gridBands[index].y2 >= bottom, 'grid band must cover every lane')
        for (const dot of row.dots) {
          assert.equal(dot.rating, ratings[dot.regionalRank - 1])
          assert.equal(dot.x, layout.rows[1 - index].dots.find((other) => other.regionalRank === dot.regionalRank)!.x)
        }
      }
    })
  }
}

test('rows keep their minimum height when teams need no extra lanes', () => {
  const regions = [{ region: 'LCK', rank: 1, score: 1800, internationalWins: 0, internationalLosses: 0,
    topTeams: [{ team: 'A', rating: 2000 }, { team: 'B', rating: 1800 }, { team: 'C', rating: 1600 }] }]
  assert.equal(regionDepthLayout(regions, 320).height, 18 + 54 + 24)
  assert.equal(regionDepthLayout(regions, 760).height, 4 + 38 + 24)
})
