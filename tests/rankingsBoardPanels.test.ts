import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WhatChanged } from '../src/components/WhatChanged.tsx'
import { compareRecord } from '../src/lib/display.ts'

test('What changed names the upset event like the match ledger, not by its source path', () => {
  // Issue #115 F2.
  const html = renderToStaticMarkup(createElement(WhatChanged, {
    period: '30 days',
    upset: { winner: 'AL', loser: 'BLG', event: 'LPL/2026 Season/Regional Finals', chance: 0.21 },
  }))

  assert.match(html, /LPL · 2026 · Regional Finals/)
  assert.doesNotMatch(html, /LPL\/2026 Season/)
})

test('record order breaks equal wins by losses, and the reverse order is its mirror', () => {
  // Issue #115 F5: T1 39-22 sorted above KC 39-18 because only wins counted.
  const records = [
    { team: 'T1', wins: 39, losses: 22 },
    { team: 'G2', wins: 37, losses: 15 },
    { team: 'KC', wins: 39, losses: 18 },
  ]

  assert.deepEqual(records.toSorted((a, b) => compareRecord(b, a)).map((record) => record.team), ['KC', 'T1', 'G2'])
  assert.deepEqual(records.toSorted(compareRecord).map((record) => record.team), ['G2', 'T1', 'KC'])
})
