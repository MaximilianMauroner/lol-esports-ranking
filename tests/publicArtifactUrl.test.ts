import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePublicArtifactUrl } from '../src/lib/publicArtifacts/url.ts'

test('external manifest rebases the complete /data artifact graph to its dataset directory', () => {
  const manifest = 'https://cdn.example/x/ranking-summary.json'
  for (const [url, expected] of [
    ['/data/scopes/season-2026.json?v=run', 'https://cdn.example/x/scopes/season-2026.json?v=run'],
    ['/data/history/team-series/index.json?v=run', 'https://cdn.example/x/history/team-series/index.json?v=run'],
    ['/data/history/team-series/All__All__All.json?v=run', 'https://cdn.example/x/history/team-series/All__All__All.json?v=run'],
    ['/data/matches/all.json?v=run', 'https://cdn.example/x/matches/all.json?v=run'],
    ['/data/matches/pages/all-1.json?v=run', 'https://cdn.example/x/matches/pages/all-1.json?v=run'],
  ] as const) assert.equal(resolvePublicArtifactUrl(url, manifest), expected)
  assert.equal(resolvePublicArtifactUrl('https://other.example/data.json', manifest), 'https://other.example/data.json')
})

test('same-origin manifest preserves the stable /data URL contract', () => {
  assert.equal(resolvePublicArtifactUrl('/data/scopes/all.json', '/data/ranking-summary.json'), '/data/scopes/all.json')
  assert.equal(resolvePublicArtifactUrl('scopes/all.json', '/data/ranking-summary.json', 'https://app.example'), 'https://app.example/data/scopes/all.json')
})
