import assert from 'node:assert/strict'
import test from 'node:test'
import { compareCodeUnits } from '../src/lib/codeUnitOrder.mjs'

test('published names order by UTF-16 code units, not by locale collation', () => {
  // ICU collation ignores case and accents at the first level; code-unit order does not.
  const names = ['kt Rolster', 'KaBuM! Esports', 'Édition', 'EDward Gaming', 'Edition', '100 Thieves', '_unknown']
  assert.deepEqual(names.toSorted(compareCodeUnits), [
    '100 Thieves', 'EDward Gaming', 'Edition', 'KaBuM! Esports', '_unknown', 'kt Rolster', 'Édition',
  ])
  assert.equal(compareCodeUnits('LCK', 'LCK'), 0)
})
