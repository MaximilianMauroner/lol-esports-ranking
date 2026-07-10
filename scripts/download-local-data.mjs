import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const defaultOracleDriveFolderId = '1gLSw0RLjBbtaNy0dgnGQDAZOHIgCe-HH'
const defaultOracleDriveFolderUrl = `https://drive.google.com/drive/folders/${defaultOracleDriveFolderId}`

const args = parseArgs(process.argv.slice(2))
const start = args.start ?? '2011-01-01'
const end = args.end ?? new Date().toISOString().slice(0, 10)
const outDir = resolve(args.outDir ?? 'data/raw')
const manifestPath = resolve(args.manifest ?? `${outDir}/manifest.json`)
const leaguepediaPath = resolve(args.leaguepediaOutput ?? `${outDir}/leaguepedia/scoreboard-games-${start}_to_${end}.json`)
const lolEsportsPath = resolve(args.lolesportsOutput ?? `${outDir}/lolesports/schedule-${start}_to_${end}.json`)
const skipOracle = isFalse(args.oracle) || args.skipOracle === true
const skipOracleDrive = isFalse(args.oracleDrive) || args.skipOracleDrive === true
const skipLeaguepedia = isFalse(args.leaguepedia) || args.skipLeaguepedia === true
const skipLolEsports = isFalse(args.lolesports) || args.skipLolesports === true || args.skipLolEsports === true
const oracleRequired = args.oracleRequired === true || args.oracleRequired === 'true'
const leaguepediaRequired = args.leaguepediaRequired === true || args.leaguepediaRequired === 'true'
const lolEsportsRequired = args.lolesportsRequired === true
  || args.lolesportsRequired === 'true'
  || args.lolEsportsRequired === true
  || args.lolEsportsRequired === 'true'
const oracleDriveFolderUrl = args.oracleDriveFolderUrl ?? defaultOracleDriveFolderUrl
const oracleDriveFolderId = args.oracleDriveFolderId ?? folderIdFromUrl(oracleDriveFolderUrl) ?? defaultOracleDriveFolderId
const oracleUrls = readList(args.oracleCsvUrl ?? process.env.ORACLES_ELIXIR_CSV_URL)
const oracleCsvPaths = []
const oracleFailures = []
const leaguepediaFailures = []
const lolEsportsFailures = []
const discoveredOracleFiles = []
const leaguepediaJsonPaths = []
const lolEsportsJsonPaths = []
const warnings = []

if (!skipOracle) {
  const oracleSources = await loadOracleSources()
  discoveredOracleFiles.push(...oracleSources)

  if (oracleSources.length === 0) {
    warnings.push(
      skipOracleDrive
        ? 'Oracle download was enabled, but Google Drive discovery was disabled and no direct Oracle CSV URL was provided.'
        : `No Oracle CSVs were discovered in ${oracleDriveFolderUrl}.`,
    )
  }

  const selectedOracleSources = oracleSources.filter((source) => sourceInDateRange(source.name, start, end))
  if (selectedOracleSources.length === 0 && oracleSources.length > 0) {
    warnings.push(`Oracle CSVs were discovered, but none matched the requested date range ${start} through ${end}.`)
  }

  for (const [index, source] of selectedOracleSources.entries()) {
    const outputPath = resolve(oracleOutputPath(source, index, selectedOracleSources.length))
    try {
      await downloadCsv(source.url, outputPath)
      oracleCsvPaths.push(outputPath)
    } catch (error) {
      const message = errorMessage(error)
      oracleFailures.push({ source: source.name, url: source.url, error: message })
      warnings.push(`Oracle source ${source.name} was not downloaded: ${message}`)
    }
  }
} else {
  warnings.push('Oracle download skipped by --oracle false or --skip-oracle.')
}

if (oracleFailures.length > 0 && oracleRequired) {
  throw new Error(`Oracle download is required but ${oracleFailures.length} Oracle source(s) failed.`)
}

if (!skipLeaguepedia) {
  try {
    await run('node', [
      'scripts/fetch-leaguepedia.mjs',
      '--start',
      start,
      '--end',
      end,
      '--output',
      leaguepediaPath,
      ...optionalArg('--base-url', args.leaguepediaBaseUrl ?? args.leaguepediaBase),
    ])
    leaguepediaJsonPaths.push(leaguepediaPath)
  } catch (error) {
    const message = errorMessage(error)
    leaguepediaFailures.push({ source: 'Leaguepedia Cargo ScoreboardGames', error: message })
    warnings.push(`Leaguepedia backup download was not completed: ${message}`)
  }
} else {
  warnings.push('Leaguepedia backup download skipped by --leaguepedia false or --skip-leaguepedia.')
}

if (leaguepediaFailures.length > 0 && leaguepediaRequired) {
  throw new Error(`Leaguepedia backup download is required but failed: ${leaguepediaFailures[0].error}`)
}

if (!skipLolEsports) {
  try {
    await run('node', [
      'scripts/fetch-lolesports-schedule.mjs',
      '--start',
      start,
      '--end',
      end,
      '--output',
      lolEsportsPath,
      '--older-pages',
      String(args.lolesportsOlderPages ?? args.lolesportsOlder ?? 4),
      '--newer-pages',
      String(args.lolesportsNewerPages ?? args.lolesportsNewer ?? 1),
      '--detail-limit',
      String(args.lolesportsDetailLimit ?? 250),
      ...optionalArg('--base-url', args.lolesportsBaseUrl ?? args.lolesportsBase),
    ])
    lolEsportsJsonPaths.push(lolEsportsPath)
  } catch (error) {
    const message = errorMessage(error)
    lolEsportsFailures.push({ source: 'LoL Esports persisted schedule API', error: message })
    warnings.push(`LoL Esports schedule reference was not downloaded: ${message}`)
  }
} else {
  warnings.push('LoL Esports schedule reference download skipped by --lolesports false or --skip-lolesports.')
}

if (lolEsportsFailures.length > 0 && lolEsportsRequired) {
  throw new Error(`LoL Esports schedule reference download is required but failed: ${lolEsportsFailures[0].error}`)
}

if (args.riotGpr !== undefined || args.skipRiotGpr === true || args.riotGprOutput !== undefined) {
  warnings.push('Riot GPR is not part of the local data-source manifest. Use pnpm run fetch:riot-gpr explicitly for manual benchmark snapshots.')
}

if (oracleCsvPaths.length === 0) {
  warnings.push('No Oracle CSVs were downloaded. Leaguepedia remains available as the backup/gap-fill source if its download succeeded.')
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  start,
  end,
  files: {
    leaguepediaJson: leaguepediaJsonPaths,
    oracleCsv: oracleCsvPaths,
    lolEsportsJson: lolEsportsJsonPaths,
  },
  sources: {
    lolesports: {
      role: 'schedule-results-reference',
      status: lolEsportsStatus({ skipLolEsports, downloaded: lolEsportsJsonPaths, failures: lolEsportsFailures }),
      downloadedCount: lolEsportsJsonPaths.length,
      downloadedThisRun: lolEsportsJsonPaths.length,
      failedCount: lolEsportsFailures.length,
      failedThisRun: lolEsportsFailures.length,
      failures: lolEsportsFailures,
      skipped: skipLolEsports,
      required: lolEsportsRequired,
      unsupportedApi: true,
    },
    oracle: {
      role: 'primary',
      status: oracleStatus({ skipOracle, downloaded: oracleCsvPaths, failures: oracleFailures }),
      folderUrl: oracleDriveFolderUrl,
      discoveredCount: discoveredOracleFiles.length,
      downloadedCount: oracleCsvPaths.length,
      downloadedThisRun: oracleCsvPaths.length,
      failedCount: oracleFailures.length,
      failedThisRun: oracleFailures.length,
      failures: oracleFailures,
      skipped: skipOracle,
      required: oracleRequired,
    },
    leaguepedia: {
      role: 'backup-gap-fill',
      status: leaguepediaStatus({ skipLeaguepedia, downloaded: leaguepediaJsonPaths, failures: leaguepediaFailures }),
      downloadedCount: leaguepediaJsonPaths.length,
      downloadedThisRun: leaguepediaJsonPaths.length,
      failedCount: leaguepediaFailures.length,
      failedThisRun: leaguepediaFailures.length,
      failures: leaguepediaFailures,
      skipped: skipLeaguepedia,
      required: leaguepediaRequired,
    },
  },
  warnings,
}

await mkdir(dirname(manifestPath), { recursive: true })
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`Wrote local data manifest to ${manifestPath}`)
if (warnings.length > 0) {
  for (const warning of warnings) console.warn(`Warning: ${warning}`)
}

async function loadOracleSources() {
  if (oracleUrls.length > 0) {
    return oracleUrls.map((url, index) => ({ url, name: fileNameForUrl(url, index), source: 'explicit-url' }))
  }

  if (skipOracleDrive) return []

  try {
    return await discoverOracleDriveCsvs(oracleDriveFolderId)
  } catch (error) {
    const message = errorMessage(error)
    oracleFailures.push({ source: 'Oracle Google Drive folder', url: oracleDriveFolderUrl, error: message })
    warnings.push(`Oracle Google Drive discovery failed: ${message}`)
    return []
  }
}

function run(command, commandArgs) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit' })
    child.on('error', rejectRun)
    child.on('exit', (code) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} ${commandArgs.join(' ')} exited with ${code}`))
    })
  })
}

async function downloadCsv(url, outputPath) {
  const response = await fetch(url, {
    headers: {
      'user-agent': args.userAgent ?? 'lol-esports-power-index-local/0.1 (public data research)',
    },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)

  const contentType = response.headers.get('content-type') ?? ''
  const body = Buffer.from(await response.arrayBuffer())
  assertCsvDownload(body, contentType)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, body)
  console.log(`Wrote ${outputPath}`)
}

async function discoverOracleDriveCsvs(folderId) {
  const url = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`
  const response = await fetch(url, {
    headers: {
      'user-agent': args.userAgent ?? 'lol-esports-power-index-local/0.1 (public data research)',
    },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} from Oracle Google Drive folder`)

  const html = await response.text()
  return Array.from(html.matchAll(/https:\/\/drive\.google\.com\/file\/d\/([^/]+)\/view\?usp=drive_web[\s\S]*?<div class="flip-entry-title">([^<]+)<\/div>/g))
    .map((match) => ({
      id: match[1],
      name: decodeHtml(match[2]),
      source: 'google-drive-folder',
      url: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(match[1])}`,
      viewUrl: `https://drive.google.com/file/d/${match[1]}/view`,
    }))
    .filter((file) => file.name.endsWith('.csv'))
}

function fileNameForUrl(url, index) {
  const parsed = new URL(url)
  const name = basename(parsed.pathname)
  if (name && name.includes('.')) return name
  return `oracles-elixir-${index + 1}.csv`
}

function oracleOutputPath(source, index, total) {
  if (args.oracleOutput && total === 1) return args.oracleOutput
  if (args.oracleOutput) return addIndexToPath(args.oracleOutput, index)
  return `${outDir}/oracles-elixir/${source.name}`
}

function addIndexToPath(path, index) {
  const extensionIndex = path.lastIndexOf('.')
  if (extensionIndex === -1) return `${path}-${index + 1}`
  return `${path.slice(0, extensionIndex)}-${index + 1}${path.slice(extensionIndex)}`
}

function sourceInDateRange(name, startDate, endDate) {
  const yearFromName = Number(name.match(/^(\d{4})_/)?.[1])
  if (!Number.isFinite(yearFromName)) return true
  const startYear = Number(startDate.slice(0, 4))
  const endYear = Number(endDate.slice(0, 4))
  return yearFromName >= startYear && yearFromName <= endYear
}

function assertCsvDownload(body, contentType) {
  const prefix = body.subarray(0, 256).toString('utf8').trimStart()
  if (contentType.includes('text/html') || prefix.startsWith('<!DOCTYPE html') || prefix.startsWith('<html')) {
    const title = prefix.match(/<title>([^<]+)<\/title>/i)?.[1]
    throw new Error(title ? `download returned HTML (${title})` : 'download returned HTML instead of CSV')
  }
  if (!prefix.includes(',')) throw new Error('download did not look like CSV')
}

function oracleStatus({ skipOracle, downloaded, failures }) {
  if (skipOracle) return 'skipped'
  if (downloaded.length > 0 && failures.length > 0) return 'partial'
  if (downloaded.length > 0) return 'downloaded'
  if (failures.length > 0) return 'failed'
  return 'unavailable'
}

function lolEsportsStatus({ skipLolEsports, downloaded, failures }) {
  if (skipLolEsports) return 'skipped'
  if (downloaded.length > 0 && failures.length > 0) return 'partial'
  if (downloaded.length > 0) return 'downloaded'
  if (failures.length > 0) return 'failed'
  return 'unavailable'
}

function leaguepediaStatus({ skipLeaguepedia, downloaded, failures }) {
  if (skipLeaguepedia) return 'skipped'
  if (downloaded.length > 0 && failures.length > 0) return 'partial'
  if (downloaded.length > 0) return 'downloaded'
  if (failures.length > 0) return 'failed'
  return 'unavailable'
}

function folderIdFromUrl(url) {
  return String(url).match(/\/folders\/([^/?#]+)/)?.[1]
}

function decodeHtml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function isFalse(value) {
  return value === false || value === 'false'
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function readList(value) {
  if (!value || value === true) return []
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function optionalArg(name, value) {
  if (value === undefined || value === null || value === true || value === '') return []
  return [name, String(value)]
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
      parsed[toCamelCase(key)] = true
    } else {
      parsed[key] = next
      parsed[toCamelCase(key)] = next
      index += 1
    }
  }
  return parsed
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}
