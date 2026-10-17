/**
 * Palette slots that follow the entity, not its position. Keys that keep
 * appearing keep their slot; new keys take the lowest free slot. A filter that
 * swaps some teams out therefore never repaints the teams that stay, which a
 * reader who learned "HLE is blue" would otherwise misread.
 */
export function assignColorSlots(previous: ReadonlyMap<string, number>, keys: readonly string[], slotCount: number) {
  const next = new Map<string, number>()
  for (const key of keys) {
    const slot = previous.get(key)
    if (slot !== undefined && slot < slotCount && ![...next.values()].includes(slot)) next.set(key, slot)
  }
  for (const key of keys) {
    if (next.has(key)) continue
    const used = new Set(next.values())
    const free = Array.from({ length: slotCount }, (_, slot) => slot).find((slot) => !used.has(slot))
    if (free === undefined) break
    next.set(key, free)
  }
  return next
}

export function sameColorSlots(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>) {
  return left.size === right.size && [...left].every(([key, slot]) => right.get(key) === slot)
}
