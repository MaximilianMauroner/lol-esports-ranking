import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

if (process.env.VITE_RANKING_DATA_URL) {
  console.log(`Static ranking data uses ${process.env.VITE_RANKING_DATA_URL}`)
  process.exit(0)
}
const path = resolve(process.env.RANKING_STATIC_DATA_DIR ?? 'public/data', 'ranking-summary.json')
try {
  await access(path)
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  if (manifest?.artifactKind !== 'public-ranking-manifest' || !manifest?.artifactMeta?.runId) throw new Error('invalid provenance')
} catch (error) {
  throw new Error('Static deployment has no validated ranking data. Run pnpm data:materialize or set VITE_RANKING_DATA_URL.', { cause: error })
}
