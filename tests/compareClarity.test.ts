import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompareDock } from '../src/components/CompareDock.tsx'
import { CompareProfileChart } from '../src/components/CompareAnalysis.tsx'

const noop = () => {}

test('region comparison is ready for every supported selection count above one', () => {
  for (let count = 0; count <= 4; count++) {
    const html = renderToStaticMarkup(createElement(CompareDock, {
      label: 'Regions', limit: 4,
      entities: Array.from({ length: count }, (_, index) => ({ id: String(index), code: `R${index}`, name: `Region ${index}` })),
      onRemove: noop, onClear: noop, onOpen: noop,
    }))
    assert.doesNotMatch(html, /Pick (?:0|-\d+) more/)
    assert.match(html, count >= 2 ? new RegExp(`Ready to compare · ${count} selected`) : count === 1 ? /Pick 1 more/ : /Pick two to compare/)
    assert.equal(/disabled=""/.test(html), count < 2)
    assert.equal(html.includes('Picking another replaces the oldest'), count === 4)
  }
})

test('profile bars disclose narrow selected ranges and lower-is-better direction', () => {
  const html = renderToStaticMarkup(createElement(CompareProfileChart<{ score: number; uncertainty: number }>, {
    title: 'Profile', eyebrow: 'Current scope',
    entities: [{ score: 2000, uncertainty: 40 }, { score: 2005, uncertainty: 50 }],
    columns: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
    metrics: [
      { key: 'power', label: 'Power', value: (entity) => entity.score, format: String, better: 'high' },
      { key: 'uncertainty', label: 'Uncertainty', value: (entity) => entity.uncertainty, format: String, better: 'low' },
    ],
  }))
  assert.match(html, /not a zero baseline/)
  assert.match(html, /Selected range: 2000 – 2005\. Higher is better/)
  assert.match(html, /Selected range: 40 – 50\. Lower is better/)
  assert.match(html, /6% visibility mark/)
})
