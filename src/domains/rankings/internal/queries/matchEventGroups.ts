import { inferLeagueFromEvent, leagueTierFor } from '../evidence/competitionTaxonomy'
import { compareCodeUnits } from '../../../../shared/codeUnitOrder.mjs'
import { compatibleMatchEvents } from './matchLedger'
import type { PublicMatchHistorySeriesRef } from '../../types'

type EventRef = Pick<PublicMatchHistorySeriesRef, 'league' | 'event'>

// Display policy only. These positions do not change competition tiers or weights.
const premierFamilies = ['Worlds', 'MSI', 'FST', 'EWC']
const leagueDisplayOrder = ['LCK', 'LPL', 'LEC', 'LCS', 'LCP', 'LTA', 'LTA N', 'CBLOL', 'PCS', 'VCS', 'LJL', 'LLA', 'LCO', 'LTA S']
const familyLabels: Record<string, string> = {
  Worlds: 'Worlds',
  MSI: 'MSI',
  FST: 'First Stand',
  EWC: 'Esports World Cup',
  'Asia Master': 'Asia Masters',
  AC: 'AC',
  ASI: 'ASI',
  DCup: 'Demacia Cup',
  KeSPA: 'KeSPA Cup',
}
const domesticTierOrder = { 'tier-one': 1, 'tier-two': 2, 'tier-three': 3, emerging: 6, unknown: 7 }

export function groupedMatchEvents(refs: readonly EventRef[], league: string) {
  const compatible = refs.filter((row) => league === 'All' || row.league === league)
  const leaguesByEvent = new Map<string, Set<string>>()
  for (const row of compatible) {
    const leagues = leaguesByEvent.get(row.event) ?? new Set<string>()
    leagues.add(row.league)
    leaguesByEvent.set(row.event, leagues)
  }

  const groups = new Map<string, { label: string; order: number; priority: number; events: string[] }>()
  for (const event of compatibleMatchEvents(compatible, 'All')) {
    const family = eventFamily(event, leaguesByEvent.get(event) ?? new Set())
    const group = eventGroup(family, event)
    const existing = groups.get(group.label)
    if (existing) existing.events.push(event)
    else groups.set(group.label, { ...group, events: [event] })
  }
  return [...groups.values()]
    .sort((left, right) => left.order - right.order || left.priority - right.priority || compareCodeUnits(left.label, right.label))
    .map(({ label, events }) => ({ label, events }))
}

function eventFamily(event: string, leagues: ReadonlySet<string>) {
  const inferred = inferLeagueFromEvent(event)
  const inferredTier = leagueTierFor(inferred).tier
  const [sourceLeague] = leagues.size === 1 ? leagues : []
  // Broad parent-league name matches must not promote development competitions.
  if (sourceLeague && leagueTierFor(sourceLeague).tier === 'emerging' && inferredTier !== 'unknown' && inferredTier !== 'emerging') {
    const sourceFamily = inferLeagueFromEvent(sourceLeague)
    return leagueTierFor(sourceFamily).tier === 'emerging' ? sourceFamily : sourceLeague
  }
  if (leagueTierFor(event).tier === 'emerging' && inferredTier !== 'emerging' && inferredTier !== 'unknown') return 'Unknown'
  if (inferred !== 'Unknown') return inferred
  // Keep these taxonomy competition codes without guessing their full names.
  const competitionCode = event.match(/^(AC|ASI)\b/i)?.[1]
  if (competitionCode) return competitionCode.toUpperCase()
  if (leagues.size !== 1) return 'Unknown'
  const [league] = leagues
  const canonical = inferLeagueFromEvent(league)
  const family = canonical === 'Unknown' ? league : canonical
  if (leagueTierFor(family).tier === 'emerging') return family
  if (leagueTierFor(league).tier === 'emerging') return league
  return leagueTierFor(event).tier === 'emerging' ? 'Unknown' : family
}

function eventGroup(family: string, event: string) {
  const premier = premierFamilies.indexOf(family)
  if (premier >= 0) {
    const qualifier = /\b(?:qualifiers?|qualifying|qualifications?|regional finals?|road to)\b/i.test(event)
    return { label: `${familyLabels[family]}${qualifier ? ' · Qualifiers' : ''}`, order: qualifier ? 4 : 0, priority: premier }
  }
  // Invitation cups stay below first-division leagues and international qualifiers.
  if (['Asia Master', 'AC', 'ASI', 'DCup', 'KeSPA'].includes(family)) {
    return { label: familyLabels[family], order: 5, priority: 0 }
  }
  const tier = leagueTierFor(family).tier
  const priority = leagueDisplayOrder.indexOf(family)
  return {
    label: tier === 'unknown' ? 'Other events' : family,
    order: domesticTierOrder[tier],
    priority: priority < 0 ? leagueDisplayOrder.length : priority,
  }
}
