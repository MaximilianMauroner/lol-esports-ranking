import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POWER_INDEX_MARK, POWER_INDEX_HEADER_MARK, POWER_INDEX_FAVICON, POWER_INDEX_MASKABLE_MARK } from '../../src/data/brandMark.ts'

// Run manually when the master mark changes. Requires ffmpeg with librsvg.
const temporary = mkdtempSync(join(tmpdir(), 'rift-delta-brand-'))
const shapes = POWER_INDEX_MARK.slice(POWER_INDEX_MARK.indexOf('>') + 1, POWER_INDEX_MARK.lastIndexOf('</svg>'))
const fullTile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#15181b"/>${shapes}</svg>`
const maskable = POWER_INDEX_MASKABLE_MARK
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#060708"/><g transform="translate(96 96) scale(2)">${shapes}</g><g font-family="DejaVu Sans, sans-serif"><text x="260" y="135" fill="#a2adb4" font-size="24">League of Legends</text><text x="260" y="195" fill="#f0f3f5" font-size="52" font-weight="bold">rift-delta</text><text x="96" y="360" fill="#f0f3f5" font-size="44">Rankings. Builds. Inspectable evidence.</text><text x="96" y="416" fill="#a2adb4" font-size="24">Esports power rankings and a patch-pinned damage lab.</text><text x="96" y="550" fill="#78d6ea" font-size="20">lol.lab4code.com</text></g><g transform="translate(914 144) scale(3.8)" opacity=".13">${shapes}</g></svg>`

function raster(svg: string, size: number, output: string) {
  const input = join(temporary, 'input.svg')
  writeFileSync(input, svg.replace('<svg ', `<svg width="${size}" height="${size}" `))
  execFileSync('ffmpeg', ['-v', 'error', '-threads', '1', '-i', input, '-frames:v', '1', output, '-y'], { timeout: 30_000 })
}

try {
  mkdirSync('public', { recursive: true })
  writeFileSync('public/logo.svg', `${POWER_INDEX_HEADER_MARK}\n`)
  writeFileSync('public/favicon.svg', `${POWER_INDEX_FAVICON}\n`)
  for (const [size, path] of [[64, 'favicon.png'], [180, 'apple-touch-icon.png'], [192, 'icon-192.png'], [512, 'logo.png']] as const) {
    raster(fullTile, size, `public/${path}`)
  }
  raster(maskable, 512, 'public/icon-512-maskable.png')
  const frames = [16, 32, 48].map((size) => {
    const path = join(temporary, `${size}.png`)
    raster(size === 16 ? POWER_INDEX_FAVICON : POWER_INDEX_MARK, size, path)
    return { size, png: readFileSync(path) }
  })
  const header = Buffer.alloc(6 + 16 * frames.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  let offset = header.length
  for (const [index, frame] of frames.entries()) {
    const at = 6 + index * 16
    header[at] = header[at + 1] = frame.size
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(frame.png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += frame.png.length
  }
  writeFileSync('public/favicon.ico', Buffer.concat([header, ...frames.map((frame) => frame.png)]))
  writeFileSync('public/og-image.svg', `${og}\n`)
  const input = join(temporary, 'og.svg')
  writeFileSync(input, og)
  execFileSync('ffmpeg', ['-v', 'error', '-threads', '1', '-i', input, '-frames:v', '1', 'public/og-image.png', '-y'], { timeout: 30_000 })
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
