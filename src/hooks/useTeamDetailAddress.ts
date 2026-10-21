import { useEffect, useState } from 'react'
import { currentHashQuery, hashWithParam, writeNavigationHash } from '../browser/navigation'
import type { RankingSummaryStanding } from '../domains/rankings/types'

type DetailState =
  | { kind: 'closed' }
  | { kind: 'open'; value: string; origin: 'pushed' | 'arrived' }
  | { kind: 'missing'; value: string; scope: ReadonlyMap<string, RankingSummaryStanding> }

function fromAddress(address: URLSearchParams): DetailState {
  const value = address.get('teamDetail')
  return value === null ? { kind: 'closed' } : { kind: 'open', value, origin: 'arrived' }
}

export function useTeamDetailAddress(
  address: URLSearchParams,
  scope: ReadonlyMap<string, RankingSummaryStanding>,
  requestedScope: string,
  effectiveScope: string,
) {
  const [model, setModel] = useState(() => ({ address, detail: fromAddress(currentHashQuery()) }))
  let detail = model.address === address ? model.detail : fromAddress(address)
  if (detail.kind === 'open' && !scope.has(detail.value)) {
    detail = { kind: 'missing', value: detail.value, scope }
  } else if (detail.kind === 'missing' && detail.scope !== scope) {
    detail = { kind: 'closed' }
  }
  if (model.address !== address || model.detail !== detail) {
    setModel({ address, detail })
  }

  useEffect(() => {
    if (detail.kind !== 'missing') return
    const [route] = window.location.hash.slice(1).split('?', 2)
    const live = currentHashQuery()
    if (route !== 'rankings' || live.get('teamDetail') !== detail.value) return
    const liveScope = live.get('scope')
    if (liveScope !== null && liveScope !== requestedScope && liveScope !== effectiveScope) return
    live.delete('teamDetail')
    writeNavigationHash(`#rankings?${live.toString()}`, 'replace')
  }, [detail, effectiveScope, requestedScope])

  function open(value: string) {
    writeNavigationHash(hashWithParam('teamDetail', value), 'push')
    setModel((current) => ({ ...current, detail: { kind: 'open', value, origin: 'pushed' } }))
  }

  function close() {
    if (detail.kind !== 'open') return
    if (detail.origin === 'pushed') {
      window.history.back()
      return
    }
    writeNavigationHash(hashWithParam('teamDetail', null), 'replace')
    setModel((current) => ({ ...current, detail: { kind: 'closed' } }))
  }

  function dismissMissing() {
    setModel((current) => ({ ...current, detail: { kind: 'closed' } }))
  }

  return {
    item: detail.kind === 'open' ? scope.get(detail.value) : undefined,
    missing: detail.kind === 'missing',
    open,
    close,
    dismissMissing,
  }
}
