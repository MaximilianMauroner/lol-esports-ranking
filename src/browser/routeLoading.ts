import { lazy } from 'react'

export const App = lazy(() => import('../App'))
export const LegalPage = lazy(() => import('../views/LegalPage').then((module) => ({ default: module.LegalPage })))

export const DpsRoute = lazy(() => import('../views/dps/DpsRoute'))
