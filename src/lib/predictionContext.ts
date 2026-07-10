import type { MatchRecord, MatchRosterSnapshot, TeamProfile, WalkForwardSegmentKey } from '../types'
import { normalizedBestOf } from './matchFormat'
import { rosterFingerprint } from './rosters'

export const walkForwardSegmentKeys = [
  'bo1',
  'bo3-bo5',
  'international',
  'cross-region',
  'side-known',
  'patch-transition',
  'roster-change',
] as const satisfies readonly WalkForwardSegmentKey[]

export function predictionSegmentsFor(
  match: MatchRecord,
  teams: Record<string, TeamProfile>,
  lastPatchByTeam: Map<string, string>,
  lastRosterFingerprintByTeam: Map<string, string>,
  resolvedBestOf = match.bestOf,
): WalkForwardSegmentKey[] {
  const segments: WalkForwardSegmentKey[] = []
  const bestOf = normalizedBestOf(resolvedBestOf)
  if (bestOf === 1) segments.push('bo1')
  if (bestOf >= 3) segments.push('bo3-bo5')
  if (isInternationalMatch(match)) segments.push('international')
  if (isCrossRegionMatch(match, teams)) segments.push('cross-region')
  if (hasKnownSideContext(match)) segments.push('side-known')
  if (isPatchTransition(match, lastPatchByTeam)) segments.push('patch-transition')
  if (isRosterChange(match, lastRosterFingerprintByTeam)) segments.push('roster-change')
  return segments
}

export function recordTeamContext(
  match: MatchRecord,
  lastRosterByTeam: Map<string, MatchRosterSnapshot>,
  lastPatchByTeam: Map<string, string>,
  lastRosterFingerprintByTeam: Map<string, string>,
) {
  recordSingleTeamContext(match.teamA, match.patch, match.teamARoster, lastRosterByTeam, lastPatchByTeam, lastRosterFingerprintByTeam)
  recordSingleTeamContext(match.teamB, match.patch, match.teamBRoster, lastRosterByTeam, lastPatchByTeam, lastRosterFingerprintByTeam)
}

function isInternationalMatch(match: MatchRecord) {
  return match.region === 'International' || ['worlds-playoffs', 'worlds-main', 'msi-bracket', 'msi-play-in', 'minor-international'].includes(match.tier)
}

function isCrossRegionMatch(match: MatchRecord, teams: Record<string, TeamProfile>) {
  const regionA = match.teamARegion ?? teams[match.teamA]?.region
  const regionB = match.teamBRegion ?? teams[match.teamB]?.region
  return Boolean(regionA && regionB && regionA !== regionB)
}

function hasKnownSideContext(match: MatchRecord) {
  return match.teamASide !== undefined && match.teamBSide !== undefined
}

function isPatchTransition(match: MatchRecord, lastPatchByTeam: Map<string, string>) {
  if (!match.patch) return false
  return [match.teamA, match.teamB].some((team) => {
    const lastPatch = lastPatchByTeam.get(team)
    return lastPatch !== undefined && lastPatch !== match.patch
  })
}

function isRosterChange(match: MatchRecord, lastRosterFingerprintByTeam: Map<string, string>) {
  return [
    [match.teamA, rosterFingerprint(match.teamARoster)] as const,
    [match.teamB, rosterFingerprint(match.teamBRoster)] as const,
  ].some(([team, currentFingerprint]) => {
    const lastFingerprint = lastRosterFingerprintByTeam.get(team)
    return currentFingerprint !== undefined && lastFingerprint !== undefined && currentFingerprint !== lastFingerprint
  })
}

function recordSingleTeamContext(
  team: string,
  patch: string,
  roster: MatchRosterSnapshot | undefined,
  lastRosterByTeam: Map<string, MatchRosterSnapshot>,
  lastPatchByTeam: Map<string, string>,
  lastRosterFingerprintByTeam: Map<string, string>,
) {
  if (patch) lastPatchByTeam.set(team, patch)
  const fingerprint = rosterFingerprint(roster)
  if (!fingerprint || !roster) return
  lastRosterByTeam.set(team, roster)
  lastRosterFingerprintByTeam.set(team, fingerprint)
}
