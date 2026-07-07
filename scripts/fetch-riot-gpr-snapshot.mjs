import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const args = parseArgs(process.argv.slice(2))
const year = args.year ?? new Date().getUTCFullYear().toString()
const milestone = args.milestone ?? 'current'
const locale = args.locale ?? 'en-US'
const output = resolve(args.output ?? `data/riot-gpr-${year}-${milestone}.json`)
const url = `https://lolesports.com/${locale}/gpr/${year}/${milestone}`

const response = await fetch(url, {
  headers: {
    'user-agent': args.userAgent ?? 'lol-esports-power-index-local/0.1 (public snapshot research)',
  },
})

if (!response.ok) {
  throw new Error(`HTTP ${response.status} from ${url}`)
}

const html = await response.text()
const payloads = extractApolloPayloads(html)

await mkdir(dirname(output), { recursive: true })
await writeFile(
  output,
  `${JSON.stringify({ source: url, fetchedAt: new Date().toISOString(), year, milestone, payloads }, null, 2)}\n`,
)

console.log(`Wrote ${payloads.length} Apollo payload blocks to ${output}`)

function extractApolloPayloads(htmlText) {
  const payloads = []
  const marker = 'window[Symbol.for("ApolloSSRDataTransport")]'
  let index = htmlText.indexOf(marker)

  while (index !== -1) {
    const pushStart = htmlText.indexOf('.push(', index)
    if (pushStart === -1) break
    const objectStart = htmlText.indexOf('{', pushStart)
    if (objectStart === -1) break
    const objectEnd = findBalancedObjectEnd(htmlText, objectStart)
    if (objectEnd === -1) break

    const rawObject = htmlText.slice(objectStart, objectEnd + 1)
    try {
      payloads.push(JSON.parse(rawObject))
    } catch {
      payloads.push({ parseError: true, raw: rawObject })
    }

    index = htmlText.indexOf(marker, objectEnd)
  }

  return payloads
}

function findBalancedObjectEnd(input, start) {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < input.length; index += 1) {
    const char = input[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) return index
  }

  return -1
}

function parseArgs(rawArgs) {
  const parsed = {}
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = rawArgs[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
    } else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}
