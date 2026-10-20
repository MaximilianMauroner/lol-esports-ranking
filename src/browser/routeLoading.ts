import { lazy } from 'react'

export const App = lazy(() => import('../App'))
export const LegalPage = lazy(() => import('../views/LegalPage').then((module) => ({ default: module.LegalPage })))
