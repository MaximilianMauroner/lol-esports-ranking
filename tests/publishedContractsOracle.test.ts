import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { artifactReferences, assertReferenceClosure } from '../src/domains/rankings/internal/published/logicalReferences.mjs'

type Cases = {
  dates: Array<{ value: string; canonical: boolean; nodeValid: boolean }>
  references: Array<{ content: string; paths: string[] }>
}
const cases: Cases = JSON.parse(readFileSync(new URL('../worker/ranking-contracts/src/published/tests/oracle-cases.json', import.meta.url), 'utf8'))

test('published canonical dates retain the Node 24 format-back and validity distinction', () => {
  assert.equal(process.versions.node.split('.')[0], '24', 'The reference runtime must be Node 24')
  for (const row of cases.dates) {
    const date = new Date(row.value)
    const valid = Number.isFinite(date.getTime())
    assert.equal(valid, row.nodeValid, row.value)
    assert.equal(valid && date.toISOString() === row.value, row.canonical, row.value)
  }
})

test('shared published reference cases follow Node field roles, order and canonical paths', () => {
  for (const row of cases.references) {
    const content: Record<string, unknown> = JSON.parse(row.content)
    assert.deepEqual(artifactReferences(content), row.paths)
    const edges = new Map([['/data/source.json', artifactReferences(content)]])
    assertReferenceClosure(edges, new Set(row.paths))
    for (const missing of row.paths) {
      assert.throws(() => assertReferenceClosure(edges, new Set(row.paths.filter((path) => path !== missing))))
    }
  }
})
