import { createHash } from 'node:crypto'
import { compareCodeUnits } from '../src/lib/codeUnitOrder.mjs'

/** SHA-256 of incremental/types.stableJson without retaining the complete text. */
export function stableJsonSha256(value: unknown): string {
  const hash = createHash('sha256')
  let pending = ''
  const write = (text: string) => {
    pending += text
    if (pending.length >= 64 * 1024) {
      hash.update(pending)
      pending = ''
    }
  }
  writeValue(value, write)
  hash.update(pending)
  return hash.digest('hex')
}

function writeValue(value: unknown, write: (text: string) => void) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Canonical ranking input cannot contain non-finite numbers')
    }
    // stableJson's array join emits an empty entry for undefined values.
    write(JSON.stringify(value) ?? '')
    return
  }
  if (value instanceof Map) {
    writeValue([...value.entries()].sort(([left], [right]) => compareCodeUnits(String(left), String(right))), write)
    return
  }
  if (value instanceof Set) {
    writeValue([...value].sort(), write)
    return
  }
  if (Array.isArray(value)) {
    write('[')
    for (let index = 0; index < value.length; index += 1) {
      if (index) write(',')
      writeValue(value[index], write)
    }
    write(']')
    return
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort(compareCodeUnits)
  write('{')
  for (const [index, key] of keys.entries()) {
    if (index) write(',')
    write(`${JSON.stringify(key)}:`)
    writeValue(record[key], write)
  }
  write('}')
}
