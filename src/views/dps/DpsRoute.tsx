import { lazy, Suspense } from 'react'
import '../../styles/dps.css'

const DpsLab = lazy(() => import('./DpsLab.tsx'))
const LoginPage = lazy(() => import('./LoginPage.tsx'))

export default function DpsRoute() {
  return <div className="dps-surface">
    <Suspense fallback={<p role="status">Loading DPS lab</p>}>
      {window.location.pathname === '/lab/login' ? <LoginPage /> : <DpsLab />}
    </Suspense>
  </div>
}
