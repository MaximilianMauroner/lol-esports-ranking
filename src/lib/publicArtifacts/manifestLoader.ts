import { parsePublicRankingManifest, type PublicRankingManifest } from './schema'

export function createPublicRankingManifestLoader(url: string, fetcher: typeof fetch = fetch) {
  let request: Promise<PublicRankingManifest> | undefined

  return function loadPublicRankingManifest() {
    request ??= fetcher(url, {
      cache: 'no-cache',
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Snapshot request failed with ${response.status}`)
        return parsePublicRankingManifest(await response.json())
      })
      .catch((error: unknown) => {
        request = undefined
        throw error
      })
    return request
  }
}
