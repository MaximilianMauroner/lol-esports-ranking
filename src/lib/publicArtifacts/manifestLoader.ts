import { parsePublicRankingManifest, type PublicRankingManifest } from './schema'
import {
  fetchPublicArtifact,
  parsePublicArtifactGenerationManifest,
  registerGenerationContext,
  validateGenerationRankingManifest,
} from './artifactIdentity'

export function createPublicRankingManifestLoader(url: string, fetcher: typeof fetch = fetch) {
  let request: Promise<PublicRankingManifest> | undefined

  return function loadPublicRankingManifest() {
    request ??= fetcher(url, {
      cache: 'no-cache',
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Snapshot request failed with ${response.status}`)
        const value: unknown = await response.json()
        if (!isGenerationManifest(value)) return parsePublicRankingManifest(value)

        const generationManifest = parsePublicArtifactGenerationManifest(value)
        registerGenerationContext(generationManifest, generationManifest, url)
        const rankingManifest = await fetchPublicArtifact(
          generationManifest,
          generationManifest.rootArtifact,
          url,
          parsePublicRankingManifest,
          { fetcher, cache: 'no-cache' },
        )
        validateGenerationRankingManifest(rankingManifest, generationManifest)
        return rankingManifest
      })
      .catch((error: unknown) => {
        request = undefined
        throw error
      })
    return request
  }
}

function isGenerationManifest(value: unknown): value is { artifactKind: 'public-artifact-generation-manifest' } {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'artifactKind' in value
    && value.artifactKind === 'public-artifact-generation-manifest')
}
