// Shared storage format. No provider or model calculations belong here.
import { compareCodeUnits } from '../codeUnitOrder.mjs'

export const ARCHIVE_FORMAT_VERSION = 1
export const ARCHIVE_PAGE_BYTES = 512_000
export const ARCHIVE_MAX_DEPTH = 24
const TARGET_BYTES = 480_000
const encoder = new TextEncoder()
const byteSize = (value) => encoder.encode(JSON.stringify(value)).byteLength

export function isPublicArchive(value) {
  return value?.artifactKind === 'public-artifact-archive'
}

export function createArchive(content, store) {
  if (byteSize(content) <= TARGET_BYTES) return content
  const tree = partition(content, store, 0)
  return { artifactKind: 'public-artifact-archive', formatVersion: ARCHIVE_FORMAT_VERSION, originalKind: content.artifactKind, tree }
}

function partition(value, store, depth, path = '') {
  if (depth > ARCHIVE_MAX_DEPTH) throw new Error('Public archive nesting limit exceeded')
  if (byteSize(value) <= TARGET_BYTES) return { kind: 'inline', value }
  if (!value || typeof value !== 'object') throw new Error('Public archive indivisible value exceeds page budget')
  const array = Array.isArray(value)
  const groups = array ? atomicGroups(value) : Object.entries(value).sort(([a], [b]) => compareCodeUnits(a, b)).map((entry) => ({ year: yearOf(entry[1], entry[0]), values: [entry] }))
  const parts = []
  let pending = [], pendingYear, pendingBytes = 0
  const flush = () => {
    if (!pending.length) return
    const chunk = array ? pending : Object.fromEntries(pending)
    const tree = partition(chunk, store, depth + 1, path)
    const reference = store({ artifactKind: 'public-archive-node', formatVersion: ARCHIVE_FORMAT_VERSION, tree })
    parts.push({ ...reference, count: pending.length, path, ...dateRange(array ? pending : pending.map((entry) => entry[1])), ...(!array ? { keyStart: pending[0][0], keyEnd: pending.at(-1)[0] } : {}), ...(pendingYear ? { year: pendingYear } : {}) })
    pending = []; pendingBytes = 0
  }
  for (const group of groups) {
    const size = byteSize(group.values)
    if (pending.length && (group.year !== pendingYear || pendingBytes + size > TARGET_BYTES)) flush()
    if (size > TARGET_BYTES && group.atomic) throw new Error(`Public archive series ${group.atomic} exceeds page budget: ${size} bytes > ${TARGET_BYTES} bytes`)
    // A single object property can itself be a large list or record. Descend
    // into that value instead of repeatedly wrapping the same one-entry map.
    if (size > TARGET_BYTES && !array) {
      flush()
      const [key, item] = group.values[0]
      const tree = { kind: 'record', entries: [[key, partition(item, store, depth + 1, `${path}/${key}`)]] }
      const reference = store({ artifactKind: 'public-archive-node', formatVersion: ARCHIVE_FORMAT_VERSION, tree })
      parts.push({ ...reference, count: 1, path, keyStart: key, keyEnd: key, ...(group.year ? { year: group.year } : {}) })
      continue
    }
    if (size > TARGET_BYTES && array) throw new Error('Public archive indivisible array item exceeds page budget')
    pendingYear = group.year; pending.push(...group.values); pendingBytes += size
  }
  flush()
  return boundedParts({ kind: array ? 'list' : 'map', parts }, store, depth)
}

function boundedParts(tree, store, depth) {
  if (byteSize(tree) <= TARGET_BYTES) return tree
  if (depth > ARCHIVE_MAX_DEPTH) throw new Error('Public archive catalog nesting limit exceeded')
  const parts = []
  for (let offset = 0; offset < tree.parts.length; offset += 512) {
    const children = tree.parts.slice(offset, offset + 512)
    const reference = store({ artifactKind: 'public-archive-node', formatVersion: ARCHIVE_FORMAT_VERSION, tree: boundedParts({ kind: tree.kind, parts: children }, store, depth + 1) })
    const years = [...new Set(children.map((entry) => entry.year))]
    parts.push({ ...reference, path: children[0].path, ...(children[0].keyStart ? { keyStart: children[0].keyStart, keyEnd: children.at(-1).keyEnd } : {}), count: children.reduce((sum, entry) => sum + entry.count, 0), ...dateRange(children), ...(years.length === 1 && years[0] ? { year: years[0] } : {}) })
  }
  return boundedParts({ kind: tree.kind, parts }, store, depth + 1)
}

function atomicGroups(items) {
  const groups = []
  for (let index = 0; index < items.length;) {
    const first = items[index]
    const atomic = first && typeof first === 'object' && !Array.isArray(first) ? first.seriesId : undefined
    const values = [first]; index++
    if (typeof atomic === 'string') while (index < items.length && items[index]?.seriesId === atomic) values.push(items[index++])
    const dates = values.map((item) => yearOf(item)).filter(Boolean).sort()
    groups.push({ values, year: dates[0], atomic })
  }
  return groups
}

function dateRange(items) {
  const starts = items.map((item) => item?.startUtcDate ?? item?.date ?? item?.datetimeUtc?.slice(0, 10)).filter((date) => typeof date === 'string').sort()
  const ends = items.map((item) => item?.endUtcDate ?? item?.date ?? item?.datetimeUtc?.slice(0, 10)).filter((date) => typeof date === 'string').sort()
  return starts.length && ends.length ? { startUtcDate: starts[0], endUtcDate: ends.at(-1) } : {}
}

function inYears(item, years) {
  const year = item.storageYear ?? item.year
  return years.includes(year) || (item.startUtcDate && item.endUtcDate && years.some((value) => value >= item.startUtcDate.slice(0, 4) && value <= item.endUtcDate.slice(0, 4)))
}

function yearOf(value, key) {
  const date = Array.isArray(value) ? (typeof value[0] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value[0]) ? value[0] : undefined) : value?.storageYear ?? value?.date ?? value?.datetimeUtc ?? value?.startUtcDate ?? value?.startDate ?? (/^\d{4}$/.test(key ?? '') ? key : undefined)
  const match = typeof date === 'string' ? /(?:^|[-/])(\d{4})(?:-|$|__|\/)/.exec(date) : undefined
  return match?.[1]
}

export function archiveReferences(content) {
  if (!isPublicArchive(content) && content?.artifactKind !== 'public-archive-node') return []
  assertArchive(content)
  const references = []
  const walk = (tree, depth) => {
    assertTree(tree, depth)
    if (tree.kind === 'record') for (const [, child] of tree.entries) walk(child, depth + 1)
    if (tree.kind === 'map' || tree.kind === 'list') references.push(...tree.parts)
  }
  walk(content.tree, 0)
  return references
}

export async function hydrateArchive(content, load, { years, records, onReference } = {}) {
  if (!isPublicArchive(content) && content?.artifactKind !== 'public-archive-node') return content
  assertArchive(content)
  const visit = async (tree, ancestors, depth) => {
    assertTree(tree, depth)
    if (tree.kind === 'inline') return { value: tree.value, count: Array.isArray(tree.value) ? tree.value.length : Object.keys(tree.value ?? {}).length }
    if (tree.kind === 'record') {
      const result = Object.create(null)
      for (const [key, child] of tree.entries) result[key] = (await visit(child, ancestors, depth + 1)).value
      return { value: result, count: tree.entries.length }
    }
    let totalCount = 0
    const result = tree.kind === 'list' ? [] : Object.create(null)
    for (const reference of tree.parts) {
      if (years && reference.year && !inYears(reference, years)) { totalCount += reference.count; continue }
      const keys = records?.[reference.path]
      if (keys && reference.keyStart && !keys.some((key) => key >= reference.keyStart && key <= reference.keyEnd)) { totalCount += reference.count; continue }
      if (ancestors.has(reference.sha256)) throw new Error('Public archive reference cycle')
      onReference?.(reference)
      const child = await load(reference)
      assertArchive(child)
      if (child.artifactKind !== 'public-archive-node') throw new Error('Public archive child kind mismatch')
      const { value, count } = await visit(child.tree, new Set([...ancestors, reference.sha256]), depth + 1)
      totalCount += count
      if (count !== reference.count) throw new Error('Public archive child count mismatch')
      if (tree.kind === 'list') {
        if (!Array.isArray(value)) throw new Error('Public archive list child must be an array')
        for (const item of value) result.push(item)
      } else {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Public archive map child must be an object')
        for (const [key, item] of Object.entries(value)) {
          if (Object.hasOwn(result, key)) throw new Error('Public archive duplicate record key')
          result[key] = item
        }
      }
    }
    return { value: result, count: totalCount }
  }
  const { value } = await visit(content.tree, new Set(), 0)
  if (isPublicArchive(content) && value?.artifactKind !== content.originalKind) throw new Error('Public archive original kind mismatch')
  return value
}

function assertArchive(value) {
  if (!value || value.formatVersion !== ARCHIVE_FORMAT_VERSION || !value.tree) throw new Error('Invalid public archive format')
}

function assertTree(tree, depth) {
  if (depth > ARCHIVE_MAX_DEPTH || !tree || typeof tree !== 'object') throw new Error('Invalid public archive tree')
  if (tree.kind === 'inline') return
  if (tree.kind === 'record') {
    if (!Array.isArray(tree.entries) || tree.entries.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')
      || new Set(tree.entries.map((entry) => entry[0])).size !== tree.entries.length) throw new Error('Invalid public archive record')
    return
  }
  if (!['map', 'list'].includes(tree.kind) || !Array.isArray(tree.parts) || !tree.parts.length) throw new Error('Invalid public archive parts')
  for (const ref of tree.parts) {
    if (([ref.startUtcDate, ref.endUtcDate].some((date) => date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date))) || (ref.startUtcDate !== undefined && (!ref.endUtcDate || ref.endUtcDate < ref.startUtcDate)) || (ref.path !== undefined && typeof ref.path !== 'string') || (ref.keyStart !== undefined && (typeof ref.keyStart !== 'string' || typeof ref.keyEnd !== 'string' || ref.keyEnd < ref.keyStart)) || !/^[a-f0-9]{64}$/.test(ref?.sha256 ?? '') || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || ref.bytes > ARCHIVE_PAGE_BYTES
      || !Number.isSafeInteger(ref.count) || ref.count <= 0 || ref.encoding !== 'gzip' || (ref.year !== undefined && !/^\d{4}$/.test(ref.year))) throw new Error('Invalid public archive reference')
  }
}

// Apply the same explicit projection to a small inline artifact and a paged
// artifact. Counts describe the returned view, not a truncated full archive.
export function projectArchiveView(content, { years, records } = {}) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content
  const result = { ...content }
  if (content.artifactKind === 'match-history-catalog' && years) {
    const pages = content.pages.filter((page) => inYears({ ...page, storageYear: page.storageYear ?? String(Math.floor(page.page / 1_000_000)) }, years))
    const pageIds = new Set(pages.map((page) => page.page))
    result.pages = pages
    result.series = content.series.filter((entry) => pageIds.has(entry.page) && inYears({ ...entry, storageYear: entry.storageYear ?? String(Math.floor(entry.page / 1_000_000)) }, years))
    result.seriesCount = result.series.length
    result.gameCount = result.series.reduce((sum, entry) => sum + entry.gameCount, 0)
  }
  if (content.artifactKind === 'team-history-scope' && records?.['/series']) {
    const keys = new Set(records['/series'])
    result.series = Object.fromEntries(Object.entries(content.series).filter(([key]) => keys.has(key)))
    result.teamCount = Object.keys(result.series).length
    result.pointCount = Object.values(result.series).reduce((sum, entry) => sum + entry.points.length, 0)
  }
  if (content.artifactKind === 'match-history-index' && records?.['/scopeIndex']) {
    const keys = new Set(records['/scopeIndex'])
    result.scopeIndex = Object.fromEntries(Object.entries(content.scopeIndex).filter(([key]) => keys.has(key)))
    if (!Object.hasOwn(result.scopeIndex, content.defaultScopeKey)) result.defaultScopeKey = Object.keys(result.scopeIndex)[0] ?? content.defaultScopeKey
  }
  if (content.artifactKind === 'region-history' && records?.['/scopes']) {
    const keys = new Set(records['/scopes'])
    result.scopes = Object.fromEntries(Object.entries(content.scopes).filter(([key]) => keys.has(key)))
    if (!Object.hasOwn(result.scopes, content.defaultScopeKey)) result.defaultScopeKey = Object.keys(result.scopes)[0] ?? content.defaultScopeKey
  }
  return result
}
