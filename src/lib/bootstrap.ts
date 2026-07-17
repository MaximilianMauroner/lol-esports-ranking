export function shouldHoldPrerenderForManifest(hash: string, legalPage: boolean) {
  return !legalPage && (!hash || hash.startsWith('#rankings'))
}
