import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { legalPageFromPath } from './lib/legal'
import './index.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Root element #root was not found')
}

const legalPage = legalPageFromPath(window.location.pathname)
const root = createRoot(rootElement)
if (legalPage) {
  const { LegalPage } = await import('./views/LegalPage')
  root.render(<StrictMode><LegalPage page={legalPage} /></StrictMode>)
} else {
  const { default: App } = await import('./App')
  root.render(<StrictMode><App /></StrictMode>)
}
