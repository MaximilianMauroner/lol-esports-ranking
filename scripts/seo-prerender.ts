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
  return renderHomepagePrerenderFromDataDir(join(rootDir, 'public/data'))
}

export async function renderHomepagePrerenderFromDataDir(publicDataDir: string) {
  const manifest = await readJson(join(publicDataDir, 'ranking-summary.json'))
  const manifestRecord = asRecord(manifest)
  if (!manifestRecord) return renderFallbackHomepagePrerender()

  const defaultSnapshotKey = stringField(manifestRecord, 'defaultSnapshotKey')
  const snapshotIndex = recordField(manifestRecord, 'snapshotIndex')
  const snapshotKey = preferredPublicSnapshotKey(Object.keys(snapshotIndex ?? {}), defaultSnapshotKey)
  const snapshotEntry = snapshotKey && snapshotIndex
    ? recordField(snapshotIndex, snapshotKey)
    : undefined
  const shardUrl = snapshotEntry ? stringField(snapshotEntry, 'url') : undefined
  const shard = shardUrl ? await readJson(publicPathForDataUrl(publicDataDir, shardUrl)) : undefined
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
  const manifest = asRecord(await readJson(join(publicDataDir, 'ranking-summary.json')))
  const generatedAt = manifest ? stringField(manifest, 'generatedAt') : undefined
  const generatedDate = generatedAt && !Number.isNaN(new Date(generatedAt).getTime())
    ? generatedAt.slice(0, 10)
    : undefined
  return generatedDate
    ? sitemap.replaceAll(/<lastmod>[^<]*<\/lastmod>/g, `<lastmod>${escapeHtml(generatedDate)}</lastmod>`)
    : sitemap
}

export function renderHomepagePrerender(data: HomepagePrerenderData) {
  const teams = data.teams.slice(0, 5)
  const regions = data.regions.slice(0, 6)
  const generatedLabel = formatDate(data.generatedAt)
  const coverageLabel = formatDateRange(data.coverageStart, data.coverageEnd)
  const sourceLabel = data.source ?? 'Oracle\'s Elixir primary with Leaguepedia Cargo gap-fill'

  return [
    `<section class="seo-prerender" aria-label="Latest LoL Esports Power Index snapshot"${data.snapshotKey ? ` data-snapshot-key="${escapeHtml(data.snapshotKey)}"` : ''}>`,
    '<div class="seo-prerender__inner">',
    '<p class="seo-prerender__eyebrow">Latest model snapshot</p>',
    '<h1>LoL Esports Power Index</h1>',
    '<p class="seo-prerender__lead">Model-versioned League of Legends esports team and region power rankings with source provenance, coverage windows, and score context.</p>',
    data.seededSample
      ? '<p class="seo-prerender__notice">Seeded sample data is loaded. These rows must not be treated as official LoL Esports rankings.</p>'
      : '',
    '<dl class="seo-prerender__stats">',
    statMarkup('Model', formatModelVersion(data.modelVersion)),
    statMarkup('Matches', formatNumber(data.matchCount)),
    statMarkup('Coverage', coverageLabel),
    statMarkup('Generated', generatedLabel),
    '</dl>',
    teams.length > 0 ? '<div class="seo-prerender__grid">' : '',
    teams.length > 0 ? [
      '<section>',
      '<h2>Top teams</h2>',
      '<ol class="seo-prerender__list">',
      ...teams.map(teamMarkup),
      '</ol>',
      '</section>',
    ].join('') : '',
    regions.length > 0 ? [
      '<section>',
      '<h2>Region power</h2>',
      '<ol class="seo-prerender__list">',
      ...regions.map(regionMarkup),
      '</ol>',
      '</section>',
    ].join('') : '',
    teams.length > 0 ? '</div>' : '',
    `<p class="seo-prerender__source">Source: ${escapeHtml(sourceLabel)}. Model config: ${escapeHtml(data.configHash ?? 'unknown')}. Latest match: ${escapeHtml(formatDate(data.latestMatchDate))}.</p>`,
    `<p class="seo-prerender__legal">${escapeHtml(RIOT_PROJECT_NOTICE)}</p>`,
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
    '<li>',
    `<span class="seo-prerender__rank">#${escapeHtml(formatNumber(team.rank))}</span>`,
    '<span>',
    `<strong>${escapeHtml(team.team)}</strong>`,
    `<small>${escapeHtml([team.code, team.region, record].filter(Boolean).join(' / '))}</small>`,
    '</span>',
    `<b>${escapeHtml(formatNumber(team.rating))}</b>`,
    '</li>',
  ].join('')
}

function regionMarkup(region: RegionSummary) {
  const detail = [
    region.flagshipLeague,
    typeof region.teamCount === 'number' ? `${formatNumber(region.teamCount)} teams` : undefined,
  ].filter(Boolean).join(' / ')
  return [
    '<li>',
    `<span class="seo-prerender__rank">#${escapeHtml(formatNumber(region.rank))}</span>`,
    '<span>',
    `<strong>${escapeHtml(region.region)}</strong>`,
    `<small>${escapeHtml(detail || 'region summary')}</small>`,
    '</span>',
    `<b>${escapeHtml(formatNumber(region.score))}</b>`,
    '</li>',
  ].join('')
}

function statMarkup(label: string, value: string) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function publicPathForDataUrl(publicDataDir: string, url: string) {
  const parsed = new URL(url, PUBLIC_SITE_ORIGIN)
  if (!parsed.pathname.startsWith('/data/')) throw new Error(`Expected public data URL, received ${url}`)
  const segments = parsed.pathname.slice(1).split('/').map(decodeSafePathSegment)
  return join(publicDataDir, ...segments.slice(1))
}

function decodeSafePathSegment(segment: string) {
  const decoded = decodeURIComponent(segment)
  if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
    throw new Error(`Unsafe public data URL segment: ${segment}`)
  }
  return decoded
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
