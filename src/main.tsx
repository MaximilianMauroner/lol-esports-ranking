import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import type { PublicRankingManifest } from './lib/publicArtifacts/schema'
import { loadPublicRankingManifest } from './hooks/usePublicArtifacts'
import { legalPageFromPath } from './lib/legal'
import { LegalPage } from './views/LegalPage'
import './index.css'
import { TooltipProvider } from './components/ui/tooltip'
import { shouldHoldPrerenderForManifest } from './lib/bootstrap'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Root element #root was not found')
}

const legalPage = legalPageFromPath(window.location.pathname)
const rankingRoot = shouldHoldPrerenderForManifest(window.location.hash, window.location.pathname, Boolean(legalPage))

let initialManifest: PublicRankingManifest | undefined
let initialManifestError: string | undefined
if (rankingRoot) {
  try {
    initialManifest = await loadPublicRankingManifest()
  } catch (error) {
    initialManifestError = error instanceof Error ? error.message : 'Unable to load snapshot'
  }
}

createRoot(rootElement).render(
  <StrictMode>
    <TooltipProvider>
      {legalPage ? <LegalPage page={legalPage} /> : <App initialManifest={initialManifest} initialManifestError={initialManifestError} />}
    </TooltipProvider>
  </StrictMode>,
)
