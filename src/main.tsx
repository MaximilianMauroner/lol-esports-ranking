import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { legalPageFromPath } from './lib/legal'
import { LegalPage } from './views/LegalPage'
import './index.css'
import { TooltipProvider } from './components/ui/tooltip'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Root element #root was not found')
}

const legalPage = legalPageFromPath(window.location.pathname)

createRoot(rootElement).render(
  <StrictMode>
    <TooltipProvider>
      {legalPage ? <LegalPage page={legalPage} /> : <App />}
    </TooltipProvider>
  </StrictMode>,
)
