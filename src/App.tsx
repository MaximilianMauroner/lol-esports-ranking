import { startTransition, Suspense, useEffect, useState } from 'react'
import { readModeFromHash, readScopeFromHash } from './browser/navigation'
import { TooltipProvider } from './components/ui/tooltip'
import { currentSeasonScope } from './domains/rankings/read'
import { ManifestRouteShell } from './views/AppShell'
import { RankingRoute } from './views/rankings/RankingRoute'
import { type Mode } from './views/shellConfig'
import { TournamentRoute } from './views/tournaments/TournamentRoute'

function App() {
  const [route, setRoute] = useState<Mode>(readModeFromHash)
  useEffect(() => {
    const onHashChange = () => startTransition(() => setRoute(readModeFromHash()))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  return <TooltipProvider>
    <Suspense fallback={<ManifestRouteShell mode={route} scope={readScopeFromHash() ?? currentSeasonScope()} />}>
      {route === 'tournaments' ? <TournamentRoute /> : <RankingRoute />}
    </Suspense>
  </TooltipProvider>
}

export default App
