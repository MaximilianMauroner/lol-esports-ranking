import type { TournamentEvent } from '../../domains/tournaments/read'

export type EventLink =
  | { kind: 'absent' }
  | { kind: 'resolved'; event: TournamentEvent; address: string }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

export function eventAddress(event: Pick<TournamentEvent, 'id' | 'competition' | 'season'>): string {
  const stage = event.id.includes('/') ? event.id.slice(event.id.lastIndexOf('/') + 1) : ''
  const slug = `${event.competition ?? 'event'} ${event.season} ${stage}`
    .normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  let hash = 2166136261
  for (let index = 0; index < event.id.length; index += 1) {
    hash ^= event.id.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${slug || 'event'}-${(hash >>> 0).toString(36).padStart(7, '0')}`
}

export function resolveEventLink(events: readonly TournamentEvent[], value: string | undefined): EventLink {
  if (!value) return { kind: 'absent' }
  const matches = new Set(events.filter((event) => event.id === value || eventAddress(event) === value))
  if (matches.size > 1) return { kind: 'ambiguous' }
  const event = matches.values().next().value
  return event ? { kind: 'resolved', event, address: eventAddress(event) } : { kind: 'missing' }
}
