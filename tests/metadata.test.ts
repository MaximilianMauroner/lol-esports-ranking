import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('social metadata uses a raster Open Graph image with declared dimensions', async () => {
  const html = await readFile('index.html', 'utf8')
  assert.match(html, /property="og:image" content="https:\/\/lol-esports-power-index\.up\.railway\.app\/og-image\.png"/)
  assert.match(html, /property="og:image:type" content="image\/png"/)
  assert.match(html, /name="twitter:image" content="https:\/\/lol-esports-power-index\.up\.railway\.app\/og-image\.png"/)

  const dimensions = await pngDimensions('public/og-image.png')
  assert.deepEqual(dimensions, { width: 1200, height: 630 })
})

test('web app manifest includes installable icon sizes', async () => {
  const manifest = JSON.parse(await readFile('public/site.webmanifest', 'utf8')) as {
    icons?: Array<{ src?: string; sizes?: string; type?: string }>
  }
  const icons = manifest.icons ?? []
  assert.ok(icons.some((icon) => icon.src === '/icon-192.png' && icon.sizes === '192x192' && icon.type === 'image/png'))
  assert.ok(icons.some((icon) => icon.src === '/logo.png' && icon.sizes === '512x512' && icon.type === 'image/png'))

  assert.deepEqual(await pngDimensions('public/icon-192.png'), { width: 192, height: 192 })
  assert.deepEqual(await pngDimensions('public/logo.png'), { width: 512, height: 512 })
})

async function pngDimensions(path: string) {
  const file = await readFile(path)
  assert.equal(file.subarray(1, 4).toString('ascii'), 'PNG')
  return {
    width: file.readUInt32BE(16),
    height: file.readUInt32BE(20),
  }
}
