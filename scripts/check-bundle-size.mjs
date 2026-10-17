import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const manifest = JSON.parse(await readFile(resolve('dist/.vite/manifest.json'), 'utf8'))
const limitBytes = Number(process.env.RANKING_MAIN_BUNDLE_LIMIT_KB ?? 800) * 1024

function dependencies(key, files = new Set()) {
  const entry = manifest[key]
  if (!entry) throw new Error(`Missing bundle entry ${key}`)
  if (files.has(entry.file)) return files
  files.add(entry.file)
  for (const imported of entry.imports ?? []) dependencies(imported, files)
  return files
}

const bootstrap = dependencies('index.html')
const ranking = dependencies('src/App.tsx', new Set(bootstrap))
const legal = dependencies('src/views/LegalPage.tsx', new Set(bootstrap))
const initial = new Set([...ranking, ...legal])
const contents = new Map(await Promise.all([...initial].map(async (file) => [
  file, await readFile(resolve('dist', file), 'utf8'),
])))
const chartFiles = [...contents].filter(([, content]) => content.includes('recharts-wrapper')).map(([file]) => file)
if (chartFiles.length) throw new Error(`Chart renderer leaked into startup dependencies: ${chartFiles.join(', ')}`)
if (legal.has(manifest['src/App.tsx'].file)) throw new Error('Legal startup must not load the ranking app')

const sizes = new Map(await Promise.all([...initial].map(async (file) => [file, (await stat(resolve('dist', file))).size])))
const rankingBytes = [...ranking].reduce((sum, file) => sum + sizes.get(file), 0)
const legalBytes = [...legal].reduce((sum, file) => sum + sizes.get(file), 0)
if (rankingBytes > limitBytes) {
  throw new Error(`Ranking startup is ${formatKb(rankingBytes)} KiB; limit is ${formatKb(limitBytes)} KiB`)
}
console.log(`Ranking startup: ${formatKb(rankingBytes)} KiB / ${formatKb(limitBytes)} KiB; legal startup: ${formatKb(legalBytes)} KiB; charts deferred`)

function formatKb(bytes) {
  return Math.round(bytes / 1024)
}
