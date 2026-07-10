import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { HOMEPAGE_PRERENDER_MARKER, PUBLIC_SITE_ORIGIN } from '../scripts/seo-prerender.ts'
import { RIOT_PROJECT_NOTICE } from '../src/lib/legal.ts'

test('crawler and social metadata use the custom canonical host', async () => {
  const html = await readFile('index.html', 'utf8')
  assert.match(html, new RegExp(`rel="canonical" href="${escapeRegExp(`${PUBLIC_SITE_ORIGIN}/`)}"`))
  assert.match(html, new RegExp(`property="og:url" content="${escapeRegExp(`${PUBLIC_SITE_ORIGIN}/`)}"`))
  assert.match(html, new RegExp(`property="og:image" content="${escapeRegExp(`${PUBLIC_SITE_ORIGIN}/og-image.png`)}"`))
  assert.match(html, /property="og:image:type" content="image\/png"/)
  assert.match(html, new RegExp(`name="twitter:image" content="${escapeRegExp(`${PUBLIC_SITE_ORIGIN}/og-image.png`)}"`))
  assert.match(html, new RegExp(`"url": "${escapeRegExp(`${PUBLIC_SITE_ORIGIN}/`)}"`))
  assert.doesNotMatch(html, /lol-esports-power-index\.up\.railway\.app/)
  assert.match(html, new RegExp(escapeRegExp(HOMEPAGE_PRERENDER_MARKER)))

  const dimensions = await pngDimensions('public/og-image.png')
  assert.deepEqual(dimensions, { width: 1200, height: 630 })
})

test('crawler entry files advertise the custom canonical host', async () => {
  const robots = await readFile('public/robots.txt', 'utf8')
  const sitemap = await readFile('public/sitemap.xml', 'utf8')
  const llms = await readFile('public/llms.txt', 'utf8')

  assert.match(robots, new RegExp(`Sitemap: ${escapeRegExp(`${PUBLIC_SITE_ORIGIN}/sitemap.xml`)}`))
  assert.match(sitemap, new RegExp(`<loc>${escapeRegExp(`${PUBLIC_SITE_ORIGIN}/`)}</loc>`))
  assert.doesNotMatch(`${robots}\n${sitemap}`, /lol-esports-power-index\.up\.railway\.app/)

  assert.match(llms, /^# LoL Esports Power Index/m)
  assert.match(llms, new RegExp(escapeRegExp(`${PUBLIC_SITE_ORIGIN}/`)))
  assert.match(llms, /\[[^\]]+\]\(https:\/\/lol\.lab4code\.com\/[^)]*\)/)
  assert.doesNotMatch(llms, /<div id="root"|<!doctype html>/i)
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

test('app shell includes the Riot project disclaimer footer', async () => {
  const app = await readFile('src/App.tsx', 'utf8')
  const legal = await readFile('src/lib/legal.ts', 'utf8')

  assert.match(RIOT_PROJECT_NOTICE, /created under Riot Games' "Legal Jibber Jabber" policy/)
  assert.match(RIOT_PROJECT_NOTICE, /Riot Games does not endorse or sponsor this project/)
  assert.match(legal, /export const RIOT_PROJECT_NOTICE/)
  assert.match(app, /className="site-footer"/)
  assert.match(app, /RIOT_PROJECT_NOTICE/)
})

test('visible SVG logo is optimized separately from the install icon', async () => {
  const logo = await readFile('public/logo.svg', 'utf8')
  assert.match(logo, /^<svg\b/)
  assert.doesNotMatch(logo, /data:image\/png;base64/)
  assert.ok(Buffer.byteLength(logo) < 4_000)
})

async function pngDimensions(path: string) {
  const file = await readFile(path)
  assert.equal(file.subarray(1, 4).toString('ascii'), 'PNG')
  return {
    width: file.readUInt32BE(16),
    height: file.readUInt32BE(20),
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
