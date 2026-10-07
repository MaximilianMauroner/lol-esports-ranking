import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJsonFor, NonCanonicalJsonError, parseCanonicalJson } from '../scripts/public-artifact-storage.mjs'

test('canonical text parsing agrees with the serializer across JSON token forms', () => {
  const cases: Array<{ text: string; canonical: boolean }> = [
    ...['null', 'true', 'false', '0', '-2', '1.25', '0.000001', '1e-7', '1e+21', '"text"', '[]', '{}'].map((text) => ({ text, canonical: true })),
    { text: '[null,true,false,0,"text"]', canonical: true },
    { text: '[[1,"x"],{"a":[null,[]],"z":{}}]', canonical: true },
    { text: '{"10":10,"2":2}', canonical: true },
    { text: '[{"10":10,"2":2}]', canonical: true },
    { text: '{"a":1,"toJSON":null,"z":2}', canonical: true },
    { text: String.raw`{"\n":1,"\"":2,"a":3,"é":4,"😀":5}`, canonical: true },
    { text: String.raw`["quote: \" slash: \\ line: \n","é😀中","/"]`, canonical: true },
    { text: String.raw`["\ud800","\u0000","\b\f\n\r\t"]`, canonical: true },
    ...[' null', 'null\n', '-0', '1.0', '1e2', '1E+21', '1e-07', '1e309', '-1e309', '9007199254740993'].map((text) => ({ text, canonical: false })),
    { text: '[1.0]', canonical: false },
    { text: '[1, 2]', canonical: false },
    { text: '{"z":2,"a":1}', canonical: false },
    { text: '{"2":2,"10":10}', canonical: false },
    { text: '[{"2":2,"10":10}]', canonical: false },
    { text: '{"a":1,"a":1}', canonical: false },
    { text: '{"a":1,"a":2}', canonical: false },
    { text: String.raw`{"a":1,"\u0061":2}`, canonical: false },
    { text: String.raw`["\u00e9"]`, canonical: false },
    { text: String.raw`["\ud83d\ude00"]`, canonical: false },
    { text: String.raw`["\/"]`, canonical: false },
    { text: String.raw`["\u000a"]`, canonical: false },
  ]
  for (const { text, canonical } of cases) {
    const value: unknown = JSON.parse(text)
    assert.equal(canonicalJsonFor(value) === text, canonical, text)
    if (canonical) assert.deepEqual(parseCanonicalJson(text), value, text)
    else assert.throws(() => parseCanonicalJson(text), NonCanonicalJsonError, text)
  }
})

test('canonical text parsing keeps syntax errors separate from noncanonical errors', () => {
  for (const text of ['', '{', '[1,]', 'undefined', 'Infinity']) {
    assert.throws(() => parseCanonicalJson(text), SyntaxError, text)
  }
})

test('canonical text parsing rejects non-text input before JSON coercion', () => {
  for (const value of [null, undefined, 1, true, {}, [], Object('null')]) {
    assert.throws(() => Reflect.apply(parseCanonicalJson, undefined, [value]), TypeError)
  }
})

test('canonical text parsing ignores inherited array toJSON hooks like the serializer', () => {
  const original = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')
  Object.defineProperty(Array.prototype, 'toJSON', {
    configurable: true,
    value() { throw new Error('Inherited toJSON must not run') },
  })
  try {
    for (const text of ['[null,true,1,"x"]', '[[1],{"a":["x"],"z":2}]']) {
      const value: unknown = JSON.parse(text)
      assert.equal(canonicalJsonFor(value), text)
      assert.deepEqual(parseCanonicalJson(text), value)
    }
    assert.throws(() => parseCanonicalJson('[1.0]'), NonCanonicalJsonError)
  } finally {
    if (original) Object.defineProperty(Array.prototype, 'toJSON', original)
    else Reflect.deleteProperty(Array.prototype, 'toJSON')
  }
})
