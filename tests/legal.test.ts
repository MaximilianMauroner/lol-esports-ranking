import assert from 'node:assert/strict'
import test from 'node:test'
import { legalPageFromPath } from '../src/lib/legal'

test('legalPageFromPath recognizes only public legal routes', () => {
  assert.equal(legalPageFromPath('/legal'), 'legal')
  assert.equal(legalPageFromPath('/privacy/'), 'privacy')
  assert.equal(legalPageFromPath('/licenses'), 'licenses')
  assert.equal(legalPageFromPath('/rankings'), undefined)
})
