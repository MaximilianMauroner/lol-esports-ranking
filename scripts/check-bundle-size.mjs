import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const assetsDir = resolve('dist/assets')
const limitBytes = Number(process.env.RANKING_MAIN_BUNDLE_LIMIT_KB ?? 900) * 1024
const files = (await readdir(assetsDir)).filter((file) => /^index-.*\.js$/.test(file))
const sizes = await Promise.all(files.map(async (file) => ({ file, bytes: (await stat(resolve(assetsDir, file))).size })))
const main = sizes.sort((left, right) => right.bytes - left.bytes)[0]

if (!main) throw new Error('No main JavaScript bundle found in dist/assets')
if (main.bytes > limitBytes) {
  throw new Error(`${main.file} is ${formatKb(main.bytes)} KB; limit is ${formatKb(limitBytes)} KB`)
}

console.log(`Main bundle ${main.file}: ${formatKb(main.bytes)} KB / ${formatKb(limitBytes)} KB`)

function formatKb(bytes) {
  return Math.round(bytes / 1024)
}
