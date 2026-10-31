import { buttonVariants } from './ui/button'

export function ProductNavigation() {
  const lab = window.location.pathname.startsWith('/lab')
  return <nav aria-label="rift-delta" className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-4 py-2">
    <a href="/" className="mr-auto font-semibold text-foreground no-underline">rift-delta</a>
    <a href="/" aria-current={!lab ? 'page' : undefined} className={buttonVariants({ variant: lab ? 'ghost' : 'secondary', size: 'sm' })}>Rankings</a>
    <a href="/lab" aria-current={lab ? 'page' : undefined} className={buttonVariants({ variant: lab ? 'secondary' : 'ghost', size: 'sm' })}>DPS lab</a>
  </nav>
}
