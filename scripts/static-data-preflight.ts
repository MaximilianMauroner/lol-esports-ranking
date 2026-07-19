import { resolve } from 'node:path'
import { validatePublicArtifactBundle } from './materialize-ranking-data.ts'

const external = process.env.VITE_RANKING_DATA_URL
if (external) {
  const url = new URL(external)
  const localHttp = url.protocol === 'http:' && url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !localHttp) throw new Error('VITE_RANKING_DATA_URL must use HTTPS')
  console.log(`Static ranking data uses external manifest ${url}`)
} else {
  const root = resolve(process.env.RANKING_STATIC_DATA_DIR ?? 'public/data')
  try {
    const validated = await validatePublicArtifactBundle(root)
    console.log(`Static ranking data validated ${validated.relativePaths.length} artifacts from ${root}`)
  } catch (error) {
    throw new Error('Static deployment has no complete validated ranking data. Run pnpm data:materialize or set VITE_RANKING_DATA_URL.', { cause: error })
  }
}
