import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { createInterface } from 'node:readline'

const SORT_BUFFER_BYTES = 32 * 1024 * 1024

export async function createNormalizedOracleChunks({ manifest, rawDir, stagingDir }) {
  const root = resolve(rawDir)
  const stagingRoot = resolve(stagingDir)
  const sourcePaths = Array.isArray(manifest?.files?.oracleCsv) ? manifest.files.oracleCsv.map(String) : []
  if (sourcePaths.length === 0) return { files: [], chunks: [], diagnostics: streamingDiagnostics(0) }
  await mkdir(stagingRoot, { recursive: true })
  const workRoot = await mkdtemp(join(tmpdir(), 'ranking-normalized-oracle-'))
  const partitions = new Map()
  let header
  try {
    for (const sourcePath of sourcePaths.toSorted()) {
      const path = await stagedOrExistingPath(sourcePath, root, stagingRoot)
      let sourceHeader
      let columns
      let naturalIndexes
      for await (const row of parseCsvStream(path)) {
        if (!sourceHeader) {
          sourceHeader = row.map((field) => field.trim())
          if (!header) header = sourceHeader
          else if (JSON.stringify(header) !== JSON.stringify(sourceHeader)) throw new Error(`Oracle CSV headers differ: ${sourcePath}`)
          columns = new Map(sourceHeader.map((name, index) => [name.toLowerCase(), index]))
          if (!columns.has('date') || !columns.has('gameid')) return { files: [], chunks: [], diagnostics: streamingDiagnostics(partitions.size) }
          naturalIndexes = ['gameid', 'position', 'side', 'playerid', 'participantid']
            .flatMap((name) => columns.has(name) ? [columns.get(name)] : [])
          continue
        }
        if (row.every((field) => field === '')) continue
        const date = row[requiredColumn(columns, 'date')] ?? ''
        const month = /^\d{4}-\d{2}/.exec(date)?.[0]
        if (!month) throw new Error(`Oracle row has no calendar month: ${date || '<missing date>'}`)
        const naturalId = naturalIndexes.map((index) => row[index] ?? '').join('\u0000')
        const canonical = serializeCsvRow(row)
        const partition = await partitionFor(partitions, workRoot, month)
        await writeWithBackpressure(partition.stream, `${encodeField(naturalId)}\t${encodeField(canonical)}\t${date.slice(0, 10)}\n`)
      }
    }
    if (!header) return { files: [], chunks: [], diagnostics: streamingDiagnostics(partitions.size) }
    await Promise.all([...partitions.values()].map(async ({ stream }) => {
      stream.end()
      await finished(stream)
    }))

    const files = []
    const chunks = []
    for (const [month, partition] of [...partitions].sort(([left], [right]) => left.localeCompare(right))) {
      const sortedPath = join(workRoot, `${month}.sorted`)
      await externalSort(partition.path, sortedPath)
      const relativePath = `normalized/oracles-elixir/${month}.csv`
      const destination = resolve(stagingRoot, relativePath)
      await mkdir(dirname(destination), { recursive: true })
      const output = createWriteStream(destination, { mode: 0o600 })
      const digest = createHash('sha256')
      let bytes = 0
      let rows = 0
      let latestDate = `${month}-01`
      let previousId
      let previousCanonical
      const writeOutput = async (contents) => {
        const buffer = Buffer.from(contents)
        digest.update(buffer)
        bytes += buffer.byteLength
        await writeWithBackpressure(output, buffer)
      }
      await writeOutput(`${serializeCsvRow(header)}\n`)
      const lines = createInterface({ input: createReadStream(sortedPath), crlfDelay: Infinity })
      for await (const line of lines) {
        const [encodedId, encodedCanonical, date] = line.split('\t')
        if (encodedId === undefined || encodedCanonical === undefined || date === undefined) throw new Error(`Invalid normalized Oracle staging row for ${month}`)
        if (encodedId === previousId) {
          if (encodedCanonical !== previousCanonical) throw new Error(`Conflicting Oracle row identity in ${month}: ${decodeField(encodedId)}`)
          continue
        }
        previousId = encodedId
        previousCanonical = encodedCanonical
        await writeOutput(`${decodeField(encodedCanonical)}\n`)
        rows += 1
        if (date > latestDate) latestDate = date
      }
      output.end()
      await finished(output)
      const writtenBytes = (await stat(destination)).size
      if (writtenBytes !== bytes) throw new Error(`Normalized Oracle chunk byte length mismatch for ${month}`)
      files.push(resolve(root, relativePath))
      chunks.push({
        provider: 'oracles-elixir',
        logicalId: relativePath,
        path: resolve(root, relativePath),
        digest: digest.digest('hex'),
        bytes,
        start: `${month}-01`,
        end: latestDate,
        rows,
      })
    }
    return { files, chunks, diagnostics: streamingDiagnostics(partitions.size) }
  } finally {
    for (const partition of partitions.values()) {
      if (!partition.stream.destroyed) partition.stream.destroy()
    }
    await rm(workRoot, { recursive: true, force: true })
  }
}

function streamingDiagnostics(partitions) {
  return {
    strategy: 'streaming-external-sort',
    sortBufferBytes: SORT_BUFFER_BYTES,
    peakParsedRowsRetained: 1,
    partitions,
  }
}

async function partitionFor(partitions, workRoot, month) {
  const existing = partitions.get(month)
  if (existing) return existing
  const path = join(workRoot, `${month}.unsorted`)
  const partition = { path, stream: createWriteStream(path, { flags: 'wx', mode: 0o600 }) }
  partitions.set(month, partition)
  return partition
}

async function writeWithBackpressure(stream, contents) {
  if (!stream.write(contents)) await once(stream, 'drain')
}

async function externalSort(input, output) {
  const child = spawn('sort', [
    '--field-separator=\t',
    '--key=1,1',
    '--key=2,2',
    `--buffer-size=${SORT_BUFFER_BYTES}`,
    `--temporary-directory=${dirname(input)}`,
    `--output=${output}`,
    input,
  ], { env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const [code] = await once(child, 'close')
  if (code !== 0) throw new Error(`Could not externally sort ${basename(input)}: ${stderr.trim() || `exit ${code}`}`)
}

async function* parseCsvStream(path) {
  const input = createReadStream(path, { encoding: 'utf8' })
  let row = []
  let field = ''
  let quoted = false
  let pendingQuote = false
  let skipLf = false
  for await (const chunk of input) {
    for (let index = 0; index < chunk.length; index += 1) {
      const char = chunk[index]
      if (skipLf) {
        skipLf = false
        if (char === '\n') continue
      }
      if (quoted) {
        if (pendingQuote) {
          pendingQuote = false
          if (char === '"') {
            field += '"'
            continue
          }
          quoted = false
        } else if (char === '"') {
          pendingQuote = true
          continue
        } else {
          field += char
          continue
        }
      }
      if (char === '"') quoted = true
      else if (char === ',') {
        row.push(field)
        field = ''
      } else if (char === '\n' || char === '\r') {
        row.push(field)
        if (row.some((value) => value !== '')) yield row
        row = []
        field = ''
        skipLf = char === '\r'
      } else field += char
    }
  }
  if (pendingQuote) quoted = false
  if (quoted) throw new Error('Oracle CSV ends inside a quoted field')
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.some((value) => value !== '')) yield row
  }
}

function encodeField(value) {
  return Buffer.from(value).toString('base64')
}

function decodeField(value) {
  return Buffer.from(value, 'base64').toString('utf8')
}

async function stagedOrExistingPath(sourcePath, rawRoot, stagingRoot) {
  const absolute = resolve(sourcePath)
  const candidateRelative = relative(rawRoot, absolute)
  if (candidateRelative && candidateRelative !== '..' && !candidateRelative.startsWith(`..${sep}`)) {
    const candidate = resolve(stagingRoot, candidateRelative)
    try {
      await access(candidate)
      return candidate
    } catch {
      // The source belongs to the retained baseline rather than this refresh window.
    }
  }
  return absolute
}

function requiredColumn(columns, name) {
  const index = columns.get(name)
  if (index === undefined) throw new Error(`Oracle CSV is missing ${name} column`)
  return index
}

function serializeCsvRow(row) {
  return row.map((field) => /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field).join(',')
}

export function parseCsv(contents) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < contents.length; index += 1) {
    const char = contents[index]
    if (quoted) {
      if (char === '"' && contents[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') quoted = false
      else field += char
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && contents[index + 1] === '\n') index += 1
      row.push(field)
      if (row.some((value) => value !== '')) rows.push(row)
      row = []
      field = ''
    } else field += char
  }
  if (quoted) throw new Error('Oracle CSV ends inside a quoted field')
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.some((value) => value !== '')) rows.push(row)
  }
  return rows
}
