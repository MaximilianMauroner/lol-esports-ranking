import { drawPots, pairReason, type DrawContext } from './swissScenario.ts'

type Pair = [string, string]

/** Each unordered perfect matching occurs once, independent of pair and team order. */
export function legalSwissMatchings(ids: readonly string[], legal: (a: string, b: string) => boolean): Pair[][] {
  if (!ids.length) return [[]]
  const [first, ...rest] = ids
  return rest.flatMap((other, index) => legal(first, other)
    ? legalSwissMatchings(rest.filter((_, position) => position !== index), legal).map((tail): Pair[] => [[first, other], ...tail])
    : [])
}

/** Hypothetical uniform legal matchings, not probabilities for Riot's draw procedure. */
export function uniformLegalSwissDraw(context: DrawContext, random: () => number, cache = new Map<string, Pair[][]>()): Pair[] {
  return drawPots(context).flatMap((pot) => {
    const ids = pot.flat()
    const legal = (a: string, b: string) => !pairReason(a, b, context)
    const key = JSON.stringify([ids, ids.map((a, index) => ids.slice(index + 1).map((b) => legal(a, b)))])
    let matchings = cache.get(key)
    if (!matchings) {
      matchings = legalSwissMatchings(ids, legal)
      if (!matchings.length) throw new Error(`Round ${context.round} has no legal draw.`)
      cache.set(key, matchings)
    }
    const value = random()
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('The random draw must be in [0, 1).')
    return matchings[Math.floor(value * matchings.length)].map((pair): Pair => [...pair])
  })
}
