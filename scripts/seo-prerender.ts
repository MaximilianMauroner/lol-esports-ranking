import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { preferredPublicSnapshotKey } from '../src/lib/defaultScope.ts'
import { RIOT_PROJECT_NOTICE } from '../src/lib/legal.ts'

export const PUBLIC_SITE_ORIGIN = 'https://lol.lab4code.com'
export const HOMEPAGE_PRERENDER_MARKER = '<!--homepage-prerender-->'
export const HOMEPAGE_PRERENDER_START_MARKER = '<!--homepage-prerender:start-->'
export const HOMEPAGE_PRERENDER_END_MARKER = '<!--homepage-prerender:end-->'
export { RIOT_PROJECT_NOTICE }

type JsonRecord = Record<string, unknown>

type HomepagePrerenderData = {
  snapshotKey?: string
  generatedAt?: string
  modelVersion?: string
  configHash?: string
  matchCount?: number
  coverageStart?: string
  coverageEnd?: string
  latestMatchDate?: string
  source?: string
  seededSample?: boolean
  teams: TeamSummary[]
  regions: RegionSummary[]
}

type TeamSummary = {
  team: string
  code?: string
  region?: string
  rank?: number
  rating?: number
  wins?: number
  losses?: number
}

type RegionSummary = {
  region: string
  rank?: number
  score?: number
  teamCount?: number
  flagshipLeague?: string
}

const numberFormatter = new Intl.NumberFormat('en')
const dateFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

export async function renderHomepagePrerenderFromPublicData(rootDir = process.cwd()) {
  return renderHomepagePrerenderFromDataDir(join(rootDir, '.generated/ranking-data'))
}

export async function renderHomepagePrerenderFromDataDir(publicDataDir: string) {
  return renderHomepagePrerenderFromLoader((relativePath) => readJson(join(publicDataDir, relativePath)))
}

export async function renderHomepagePrerenderFromLoader(loadJson: (relativePath: string) => Promise<unknown>) {
  const manifest = await loadJson('ranking-summary.json')
  const manifestRecord = asRecord(manifest)
  if (!manifestRecord) return renderFallbackHomepagePrerender()

  const defaultSnapshotKey = stringField(manifestRecord, 'defaultSnapshotKey')
  const snapshotIndex = recordField(manifestRecord, 'snapshotIndex')
  const snapshotKey = preferredPublicSnapshotKey(Object.keys(snapshotIndex ?? {}), defaultSnapshotKey)
  const snapshotEntry = snapshotKey && snapshotIndex
    ? recordField(snapshotIndex, snapshotKey)
    : undefined
  const shardUrl = snapshotEntry ? stringField(snapshotEntry, 'url') : undefined
  const shard = shardUrl ? await loadJson(relativePathForDataUrl(shardUrl)) : undefined
  const shardRecord = asRecord(shard)

  return renderHomepagePrerender({
    ...extractHomepagePrerenderData(manifestRecord, shardRecord),
    snapshotKey,
  })
}

export function injectHomepagePrerender(html: string, prerendered: string) {
  const start = html.indexOf(HOMEPAGE_PRERENDER_START_MARKER)
  const end = html.indexOf(HOMEPAGE_PRERENDER_END_MARKER)
  if (start === -1 || end === -1 || end < start) return html
  const contentStart = start + HOMEPAGE_PRERENDER_START_MARKER.length
  return `${html.slice(0, contentStart)}${prerendered}${html.slice(end)}`
}

export async function renderSitemapFromDataDir(publicDataDir: string, sitemap: string) {
  return renderSitemapFromManifest(await readJson(join(publicDataDir, 'ranking-summary.json')), sitemap)
}

export function renderSitemapFromManifest(value: unknown, sitemap: string) {
  const manifest = asRecord(value)
  const generatedAt = manifest ? stringField(manifest, 'generatedAt') : undefined
  const generatedDate = generatedAt && !Number.isNaN(new Date(generatedAt).getTime())
    ? generatedAt.slice(0, 10)
    : undefined
  return generatedDate
    ? sitemap.replaceAll(/<lastmod>[^<]*<\/lastmod>/g, `<lastmod>${escapeHtml(generatedDate)}</lastmod>`)
    : sitemap
}

function relativePathForDataUrl(url: string) {
  const parsed = new URL(url, PUBLIC_SITE_ORIGIN)
  if (!parsed.pathname.startsWith('/data/')) throw new Error(`Unsupported public artifact URL: ${url}`)
  return parsed.pathname.slice('/data/'.length).split('/').map((segment) => {
    const decoded = decodeURIComponent(segment)
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new Error(`Unsafe public artifact URL: ${url}`)
    }
    return decoded
  }).join('/')
}

export function renderHomepagePrerender(data: HomepagePrerenderData) {
  const teams = data.teams.slice(0, 5)
  const regions = data.regions.slice(0, 6)
  const generatedLabel = formatDate(data.generatedAt)
  const coverageLabel = formatDateRange(data.coverageStart, data.coverageEnd)
  const sourceLabel = data.source ?? 'Oracle\'s Elixir primary with Leaguepedia Cargo gap-fill'

  return [
    `<section class="min-h-full px-[var(--page-x)] py-[clamp(28px,6vw,72px)]" aria-label="Latest LoL Esports Power Index snapshot"${data.snapshotKey ? ` data-snapshot-key="${escapeHtml(data.snapshotKey)}"` : ''}>`,
    '<div class="mx-auto max-w-[1080px] [&>h1]:mt-2 [&>h1]:text-[3.4rem] [&>h1]:font-[720] [&>h1]:tracking-normal [&>h1]:text-[var(--text-strong)] max-[760px]:[&>h1]:text-[2.2rem]">',
    '<p class="text-[0.72rem] font-[720] tracking-[0.16em] text-[var(--rank-gold)] uppercase">Latest model snapshot</p>',
    '<h1>LoL Esports Power Index</h1>',
    '<p class="mt-3 max-w-[760px] text-base leading-[1.55] text-[var(--muted)]">Model-versioned League of Legends esports team and region power rankings with source provenance, coverage windows, and score context.</p>',
    data.seededSample
      ? '<p class="mt-3.5 max-w-[760px] rounded-[var(--r-sm)] border border-[color-mix(in_oklch,var(--warn)_46%,var(--line))] bg-[var(--warn-soft)] px-3 py-2.5 text-[var(--text-strong)]">Seeded sample data is loaded. These rows must not be treated as official LoL Esports rankings.</p>'
      : '',
    '<dl class="mt-7 grid grid-cols-4 gap-px overflow-hidden rounded-[var(--r)] border border-[var(--line)] bg-[var(--line)] max-[760px]:grid-cols-1">',
    statMarkup('Model', formatModelVersion(data.modelVersion)),
    statMarkup('Matches', formatNumber(data.matchCount)),
    statMarkup('Coverage', coverageLabel),
    statMarkup('Generated', generatedLabel),
    '</dl>',
    teams.length > 0 ? '<div class="mt-7 grid grid-cols-2 gap-5 max-[760px]:grid-cols-1">' : '',
    teams.length > 0 ? [
      '<section>',
      '<h2 class="text-base font-bold text-[var(--text-strong)]">Top teams</h2>',
      '<ol class="mt-2.5 grid list-none gap-px overflow-hidden rounded-[var(--r)] border border-[var(--line)] bg-[var(--line)] p-0">',
      ...teams.map(teamMarkup),
      '</ol>',
      '</section>',
    ].join('') : '',
    regions.length > 0 ? [
      '<section>',
      '<h2 class="text-base font-bold text-[var(--text-strong)]">Region power</h2>',
      '<ol class="mt-2.5 grid list-none gap-px overflow-hidden rounded-[var(--r)] border border-[var(--line)] bg-[var(--line)] p-0">',
      ...regions.map(regionMarkup),
      '</ol>',
      '</section>',
    ].join('') : '',
    teams.length > 0 ? '</div>' : '',
    `<p class="mt-[18px] max-w-[880px] text-[0.78rem] leading-normal text-[var(--muted)]">Source: ${escapeHtml(sourceLabel)}. Model config: ${escapeHtml(data.configHash ?? 'unknown')}. Latest match: ${escapeHtml(formatDate(data.latestMatchDate))}.</p>`,
    `<p class="mt-2.5 max-w-[880px] text-[0.78rem] leading-normal text-[var(--faint)]">${escapeHtml(RIOT_PROJECT_NOTICE)}</p>`,
    '</div>',
    '</section>',
  ].filter(Boolean).join('')
}

export function renderFallbackHomepagePrerender() {
  return renderHomepagePrerender({
    source: 'Oracle\'s Elixir primary with Leaguepedia Cargo gap-fill',
    teams: [],
    regions: [],
  })
}

function extractHomepagePrerenderData(manifest: JsonRecord, shard: JsonRecord | undefined): HomepagePrerenderData {
  const model = recordField(manifest, 'model')
  const coverage = recordField(manifest, 'coverage')
  return {
    generatedAt: stringField(manifest, 'generatedAt'),
    modelVersion: model ? stringField(model, 'version') : undefined,
    configHash: model ? stringField(model, 'configHash') : undefined,
    matchCount: numberField(shard, 'matchCount') ?? numberField(coverage, 'matchCount'),
    coverageStart: stringField(coverage, 'coverageStart'),
    coverageEnd: stringField(coverage, 'coverageEnd'),
    latestMatchDate: stringField(coverage, 'latestMatchDate'),
    source: stringField(manifest, 'source'),
    seededSample: booleanField(coverage, 'seededSample'),
    teams: arrayField(shard, 'standings').flatMap(teamSummary).sort(compareOptionalRank),
    regions: arrayField(shard, 'regions').flatMap(regionSummary).sort(compareOptionalRank),
  }
}

function teamSummary(value: unknown): TeamSummary[] {
  const record = asRecord(value)
  if (!record) return []
  const team = stringField(record, 'team')
  if (!team) return []
  const eligibility = recordField(record, 'eligibility')
  if (booleanField(eligibility, 'eligible') === false) return []
  return [{
    team,
    code: stringField(record, 'code'),
    region: stringField(record, 'region'),
    rank: numberField(record, 'rank'),
    rating: numberField(record, 'rating'),
    wins: numberField(record, 'wins'),
    losses: numberField(record, 'losses'),
  }]
}

function regionSummary(value: unknown): RegionSummary[] {
  const record = asRecord(value)
  const region = record ? stringField(record, 'region') : undefined
  if (!record || !region) return []
  return [{
    region,
    rank: numberField(record, 'rank'),
    score: numberField(record, 'score'),
    teamCount: numberField(record, 'teamCount'),
    flagshipLeague: stringField(record, 'flagshipLeague'),
  }]
}

function teamMarkup(team: TeamSummary) {
  const record = typeof team.wins === 'number' && typeof team.losses === 'number'
    ? `${formatNumber(team.wins)}-${formatNumber(team.losses)}`
    : 'record unavailable'
  return [
    '<li class="grid min-h-[58px] grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-3 bg-[var(--surface)] px-[13px] py-[11px]">',
    `<span class="font-[760] text-[var(--rank-gold)] tabular-nums">#${escapeHtml(formatNumber(team.rank))}</span>`,
    '<span class="min-w-0">',
    `<strong class="block overflow-hidden text-ellipsis whitespace-nowrap text-[var(--text-strong)]">${escapeHtml(team.team)}</strong>`,
    `<small class="block overflow-hidden text-ellipsis whitespace-nowrap text-[0.78rem] text-[var(--muted)]">${escapeHtml([team.code, team.region, record].filter(Boolean).join(' / '))}</small>`,
    '</span>',
    `<b class="text-[var(--accent-strong)] tabular-nums">${escapeHtml(formatNumber(team.rating))}</b>`,
    '</li>',
  ].join('')
}

function regionMarkup(region: RegionSummary) {
  const detail = [
    region.flagshipLeague,
    typeof region.teamCount === 'number' ? `${formatNumber(region.teamCount)} teams` : undefined,
  ].filter(Boolean).join(' / ')
  return [
    '<li class="grid min-h-[58px] grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-3 bg-[var(--surface)] px-[13px] py-[11px]">',
    `<span class="font-[760] text-[var(--rank-gold)] tabular-nums">#${escapeHtml(formatNumber(region.rank))}</span>`,
    '<span class="min-w-0">',
    `<strong class="block overflow-hidden text-ellipsis whitespace-nowrap text-[var(--text-strong)]">${escapeHtml(region.region)}</strong>`,
    `<small class="block overflow-hidden text-ellipsis whitespace-nowrap text-[0.78rem] text-[var(--muted)]">${escapeHtml(detail || 'region summary')}</small>`,
    '</span>',
    `<b class="text-[var(--accent-strong)] tabular-nums">${escapeHtml(formatNumber(region.score))}</b>`,
    '</li>',
  ].join('')
}

function statMarkup(label: string, value: string) {
  return `<div class="bg-[var(--surface)] px-3.5 py-[13px]"><dt class="text-[0.7rem] font-[680] text-[var(--faint)] uppercase">${escapeHtml(label)}</dt><dd class="mt-[5px] text-[0.92rem] font-[680] text-[var(--text-strong)]">${escapeHtml(value)}</dd></div>`
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function arrayField(record: JsonRecord | undefined, key: string): unknown[] {
  const value = record?.[key]
  return Array.isArray(value) ? value : []
}

function recordField(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  return asRecord(record?.[key])
}

function stringField(record: JsonRecord | undefined, key: string) {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function numberField(record: JsonRecord | undefined, key: string) {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanField(record: JsonRecord | undefined, key: string) {
  const value = record?.[key]
  return typeof value === 'boolean' ? value : undefined
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function compareOptionalRank(left: { rank?: number }, right: { rank?: number }) {
  return (left.rank ?? Number.POSITIVE_INFINITY) - (right.rank ?? Number.POSITIVE_INFINITY)
}

function formatNumber(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? numberFormatter.format(value) : 'Unknown'
}

function formatDate(value?: string) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : dateFormatter.format(date)
}

function formatDateRange(start?: string, end?: string) {
  if (!start && !end) return 'Unknown window'
  return `${formatDate(start)} - ${formatDate(end)}`
}

function formatModelVersion(value?: string) {
  return value ? value.replaceAll('transparent-gpr', 'transparent-power-index') : 'unknown'
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}
