import { teamBranding } from './teamBranding.generated'

export type TeamBranding = {
  code: string
  source: 'lol-esports' | 'leaguepedia' | 'name-derived'
  sourceName: string
  sourceUrl?: string
  logo?: string
  remoteLogoUrl?: string
}

export function teamBrandingFor(teamName: string): TeamBranding | undefined {
  return (teamBranding as Record<string, TeamBranding>)[teamName]
}

export function teamLogoFor(teamName: string) {
  return teamBrandingFor(teamName)?.logo
}

export function withAuditedTeamCodes<T>(value: T): T {
  const visited = new Set<object>()

  function visit(candidate: unknown) {
    if (!candidate || typeof candidate !== 'object' || visited.has(candidate)) return
    visited.add(candidate)
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }

    const record = candidate as Record<string, unknown>
    const teamName = typeof record.team === 'string'
      ? record.team
      : typeof record.name === 'string' && typeof record.code === 'string'
        ? record.name
        : undefined
    const auditedCode = teamName ? teamBrandingFor(teamName)?.code : undefined
    if (auditedCode && typeof record.code === 'string') record.code = auditedCode
    Object.values(record).forEach(visit)
  }

  visit(value)
  return value
}
