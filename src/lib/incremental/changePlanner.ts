import type { MatchRecord } from '../../types'
import { earliestAppearance } from './dependencyDigests'
import type { IncrementalFallbackReason } from './types'

export type ReducerBoundary = {
  mode: 'reuse' | 'replay' | 'envelope-only'
  replayFrom?: string
  reason: string
}

export type IncrementalCrunchPlan = {
  kind: 'no-change' | 'incremental' | 'metadata-only' | 'full-fallback'
  canonical: ReducerBoundary
  team: ReducerBoundary
  livePlayerEdge: ReducerBoundary
  player: ReducerBoundary
  artifacts: ReducerBoundary
  checkpointBefore?: string
  fallback?: IncrementalFallbackReason
}

export type IncrementalChange =
  | { kind: 'canonical-row'; operation: 'add'; newDate: string }
  | { kind: 'canonical-row'; operation: 'delete'; oldDate: string }
  | { kind: 'canonical-row'; operation: 'edit' | 'provider-promotion'; oldDate: string; newDate: string }
  | { kind: 'identity-context'; dependency: 'identity' | 'profile' | 'home-league' | 'alias'; identities: string[]; closureComplete: boolean }
  | { kind: 'rating-universe'; oldDate?: string; newDate?: string; membershipKnown: true }
  | { kind: 'rating-universe'; membershipKnown: false }
  | { kind: 'worlds-context'; affectedDates: string[]; complete: boolean }
  | { kind: 'tournament-context'; tournamentStart: string; checkpointDates: string[]; complete: boolean }
  | { kind: 'player-league-strength'; identities: string[] }
  | { kind: 'team-player-edge'; status: 'unchanged' | 'pending' }
  | { kind: 'team-player-edge'; status: 'changed'; earliestDate: string }
  | { kind: 'metadata-only' }
  | { kind: 'compatibility'; dependency: 'calendar' | 'model' | 'config' | 'pipeline' | 'code' | 'private-schema'; expected: string; actual?: string }
  | { kind: 'unknown'; dependency: string }

export function planIncrementalCrunch({
  changes,
  matches,
}: {
  changes: IncrementalChange[]
  matches: MatchRecord[]
}): IncrementalCrunchPlan {
  if (changes.length === 0) return noChangePlan()
  if (changes.every((change) => change.kind === 'metadata-only')) return metadataOnlyPlan()
  for (const change of changes) {
    if (change.kind === 'unknown') return fallbackPlan({ kind: 'dependency-unknown', dependency: change.dependency })
    if (change.kind === 'compatibility') {
      return fallbackPlan({
        kind: 'compatibility-hash-mismatch',
        dependency: change.dependency,
        expected: change.expected,
        ...(change.actual ? { actual: change.actual } : {}),
      })
    }
    if (change.kind === 'identity-context' && !change.closureComplete) {
      return fallbackPlan({ kind: 'dependency-unknown', dependency: `${change.dependency}-closure` })
    }
    if (change.kind === 'rating-universe' && !change.membershipKnown) {
      return fallbackPlan({ kind: 'dependency-unknown', dependency: 'rating-universe-membership' })
    }
    if (change.kind === 'worlds-context' && !change.complete) {
      return fallbackPlan({ kind: 'dependency-unknown', dependency: 'worlds-weight-context' })
    }
    if (change.kind === 'tournament-context' && !change.complete) {
      return fallbackPlan({ kind: 'dependency-unknown', dependency: 'tournament-lifecycle' })
    }
    if (change.kind === 'canonical-row' && !canonicalChangeHasDates(change)) {
      return fallbackPlan({ kind: 'dependency-unknown', dependency: `canonical-${change.operation}-date` })
    }
    if (change.kind === 'rating-universe' && change.membershipKnown && !earliest([change.oldDate, change.newDate])) {
      return fallbackPlan({ kind: 'dependency-unknown', dependency: 'rating-universe-date' })
    }
    if (change.kind === 'identity-context' && (change.identities.length === 0 || !earliestAppearance(matches, change.identities))) {
      return fallbackPlan({ kind: 'dependency-unknown', dependency: `${change.dependency}-appearance` })
    }
    if (change.kind === 'worlds-context' && !earliest(change.affectedDates)) {
      return fallbackPlan({ kind: 'dependency-unknown', dependency: 'worlds-affected-date' })
    }
    if (change.kind === 'tournament-context' && (!isIsoDate(change.tournamentStart) || !change.checkpointDates.some((date) => isIsoDate(date) && date < change.tournamentStart))) {
      return fallbackPlan({ kind: 'checkpoint-unavailable', detail: `No checkpoint strictly before ${change.tournamentStart}` })
    }
    if (change.kind === 'player-league-strength' && (change.identities.length === 0 || !earliestAppearance(matches, change.identities))) {
      return fallbackPlan({ kind: 'dependency-unknown', dependency: 'player-league-strength-appearance' })
    }
    if (change.kind === 'team-player-edge' && change.status === 'changed' && !isIsoDate(change.earliestDate)) {
      return fallbackPlan({ kind: 'dependency-unknown', dependency: 'live-player-edge-date' })
    }
  }

  const canonicalDates: string[] = []
  const teamDates: string[] = []
  const liveEdgeDates: string[] = []
  const playerDates: string[] = []
  let checkpointBefore: string | undefined
  for (const change of changes) {
    if (change.kind === 'canonical-row') {
      const date = earliest(canonicalChangeDates(change))
      if (date) {
        canonicalDates.push(date)
        teamDates.push(date)
        liveEdgeDates.push(date)
        playerDates.push(date)
      }
    } else if (change.kind === 'rating-universe' && change.membershipKnown) {
      const date = earliest([change.oldDate, change.newDate])
      if (date) {
        canonicalDates.push(date)
        teamDates.push(date)
        liveEdgeDates.push(date)
        playerDates.push(date)
      }
    } else if (change.kind === 'identity-context') {
      const date = earliestAppearance(matches, change.identities)
      if (date) {
        canonicalDates.push(date)
        teamDates.push(date)
        liveEdgeDates.push(date)
        playerDates.push(date)
      }
    } else if (change.kind === 'worlds-context') {
      const date = earliest(change.affectedDates)
      if (date) {
        teamDates.push(date)
        liveEdgeDates.push(date)
        playerDates.push(date)
      }
    } else if (change.kind === 'tournament-context') {
      canonicalDates.push(change.tournamentStart)
      teamDates.push(change.tournamentStart)
      liveEdgeDates.push(change.tournamentStart)
      playerDates.push(change.tournamentStart)
      checkpointBefore = change.checkpointDates.filter((date) => isIsoDate(date) && date < change.tournamentStart).sort().at(-1)
    } else if (change.kind === 'player-league-strength') {
      const date = earliestAppearance(matches, change.identities)
      if (date) playerDates.push(date)
    } else if (change.kind === 'team-player-edge') {
      if (change.status === 'changed' && change.earliestDate) teamDates.push(change.earliestDate)
      if (change.status === 'pending') {
        const firstDate = matches.map((match) => match.date).sort()[0]
        if (firstDate) teamDates.push(firstDate)
      }
    }
  }
  const canonicalFrom = earliest(canonicalDates)
  const teamFrom = earliest(teamDates)
  const liveEdgeFrom = earliest(liveEdgeDates)
  const playerFrom = earliest(playerDates)
  return {
    kind: 'incremental',
    canonical: boundary(canonicalFrom, 'canonical dependency change'),
    team: boundary(teamFrom, 'team dependency change'),
    livePlayerEdge: boundary(liveEdgeFrom, 'pregame player-edge dependency change'),
    player: boundary(playerFrom, 'player dependency change'),
    artifacts: boundary(earliest([canonicalFrom, teamFrom, liveEdgeFrom, playerFrom]), 'semantic dependency change'),
    ...(checkpointBefore ? { checkpointBefore } : {}),
  }
}

function boundary(replayFrom: string | undefined, reason: string): ReducerBoundary {
  return replayFrom ? { mode: 'replay', replayFrom, reason } : { mode: 'reuse', reason: 'dependency unchanged' }
}

function metadataOnlyPlan(): IncrementalCrunchPlan {
  const reused: ReducerBoundary = { mode: 'reuse', reason: 'metadata-only change' }
  return {
    kind: 'metadata-only',
    canonical: reused,
    team: reused,
    livePlayerEdge: reused,
    player: reused,
    artifacts: { mode: 'envelope-only', reason: 'run metadata changed' },
  }
}

function noChangePlan(): IncrementalCrunchPlan {
  const reused: ReducerBoundary = { mode: 'reuse', reason: 'no semantic or metadata change' }
  return { kind: 'no-change', canonical: reused, team: reused, livePlayerEdge: reused, player: reused, artifacts: reused }
}

function fallbackPlan(fallback: IncrementalFallbackReason): IncrementalCrunchPlan {
  const full: ReducerBoundary = { mode: 'replay', reason: 'full replay required' }
  return { kind: 'full-fallback', canonical: full, team: full, livePlayerEdge: full, player: full, artifacts: full, fallback }
}

function earliest(dates: Array<string | undefined>): string | undefined {
  return dates.filter((date): date is string => Boolean(date && isIsoDate(date))).sort()[0]
}

function isIsoDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const parsed = new Date(`${date}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date
}

function canonicalChangeHasDates(change: Extract<IncrementalChange, { kind: 'canonical-row' }>): boolean {
  if (change.operation === 'add') return Boolean(earliest([change.newDate]))
  if (change.operation === 'delete') return Boolean(earliest([change.oldDate]))
  return Boolean(earliest([change.oldDate]) && earliest([change.newDate]))
}

function canonicalChangeDates(change: Extract<IncrementalChange, { kind: 'canonical-row' }>): string[] {
  if (change.operation === 'add') return [change.newDate]
  if (change.operation === 'delete') return [change.oldDate]
  return [change.oldDate, change.newDate]
}
