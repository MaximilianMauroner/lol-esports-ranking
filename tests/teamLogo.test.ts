import assert from 'node:assert/strict'
import test from 'node:test'
import { logoTreatment } from '../src/lib/teamLogo.ts'

function pixels(count: number, rgba: [number, number, number, number]) {
  return Array.from({ length: count }, () => rgba).flat()
}

test('a wordmark wider than two to one falls back to the team code', () => {
  // The published SK Gaming and Fnatic logos are 5000 x 951 and 5000 x 732.
  assert.equal(logoTreatment(5000, 951, pixels(16, [20, 20, 20, 255])), 'code')
  assert.equal(logoTreatment(5000, 732, pixels(16, [255, 90, 0, 255])), 'code')
})

test('an image with no visible pixels falls back to the team code', () => {
  assert.equal(logoTreatment(64, 64, pixels(16, [255, 255, 255, 0])), 'code')
})

test('a near-black monochrome logo is inverted for the dark tile', () => {
  // A black mark on a transparent background, with grey anti-aliased edges.
  const mark = [...pixels(12, [0, 0, 0, 0]), ...pixels(10, [8, 8, 8, 255]), ...pixels(1, [60, 60, 62, 255])]
  assert.equal(logoTreatment(500, 500, mark), 'invert')
})

test('coloured, light and mixed logos are shown as published', () => {
  // A saturated red reads on the dark tile although its luminance is low.
  assert.equal(logoTreatment(500, 500, pixels(16, [226, 1, 45, 255])), 'logo')
  assert.equal(logoTreatment(500, 500, pixels(16, [250, 250, 250, 255])), 'logo')
  // Black lettering beside an orange symbol: inverting would turn the symbol blue.
  assert.equal(logoTreatment(500, 500, [...pixels(8, [10, 10, 10, 255]), ...pixels(4, [255, 90, 0, 255])]), 'logo')
})
