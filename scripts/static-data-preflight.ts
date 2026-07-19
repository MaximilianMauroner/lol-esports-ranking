import { resolve } from 'node:path'
import { normalizeExternalRankingManifestUrl } from '../src/lib/publicArtifacts/url.ts'
import { validatePublicArtifactBundle } from './materialize-ranking-data.ts'
import { assertReleaseData } from './release-data-assertions.ts'

const external = process.env.VITE_RANKING_DATA_URL
if (external) {
  const url = new URL(normalizeExternalRankingManifestUrl(external))
  const localHttp = url.protocol === 'http:' && url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !localHttp) throw new Error('VITE_RANKING_DATA_URL must use HTTPS')
  console.log(`Static ranking data uses external manifest ${url}; local live-data golden checks are unavailable, so validate the remote dataset separately before release.`)
} else {
  const root = resolve(process.env.RANKING_STATIC_DATA_DIR ?? 'public/data')
  let validated
  try {
    validated = await validatePublicArtifactBundle(root)
  } catch (error) {
    throw new Error('Static deployment has no complete validated ranking data. Run pnpm data:materialize or set VITE_RANKING_DATA_URL.', { cause: error })
  }
  await assertReleaseData(root, { allowFixture: process.env.RANKING_RELEASE_DATA_ALLOW_FIXTURE === 'true' })
  console.log(`Static ranking data validated ${validated.relativePaths.length} artifacts from ${root}`)
}
