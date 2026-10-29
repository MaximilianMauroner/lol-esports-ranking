import { afterEach, expect, test, vi } from 'vitest'
import { archiveConfig } from '../../scripts/dps/storage/archive.ts'

afterEach(() => vi.unstubAllEnvs())

function setArchiveEnvironment() {
  for (const name of ['BUCKET', 'ENDPOINT', 'REGION', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'RAILWAY_BUCKET', 'S3_BUCKET', 'S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
    vi.stubEnv(name, 'ranking-only')
  }
  for (const name of ['BUCKET', 'ENDPOINT', 'REGION', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) {
    vi.stubEnv(`DPS_ARCHIVE_${name}`, undefined)
  }
}

test('generic ranking credentials never enable private DPS archive access', () => {
  setArchiveEnvironment()
  expect(archiveConfig()).toBeNull()
})

test('partial DPS archive configuration cannot mix with ranking credentials', () => {
  setArchiveEnvironment()
  vi.stubEnv('DPS_ARCHIVE_BUCKET', 'private-dps')
  vi.stubEnv('DPS_ARCHIVE_ENDPOINT', 'https://private.invalid')
  expect(archiveConfig()).toBeNull()
})

test('complete DPS archive configuration selects only the explicit private bucket', () => {
  setArchiveEnvironment()
  vi.stubEnv('DPS_ARCHIVE_BUCKET', 'private-dps')
  vi.stubEnv('DPS_ARCHIVE_ENDPOINT', 'https://private.invalid')
  vi.stubEnv('DPS_ARCHIVE_ACCESS_KEY_ID', 'fixture-key')
  vi.stubEnv('DPS_ARCHIVE_SECRET_ACCESS_KEY', 'fixture-secret')
  expect(archiveConfig()).toEqual({
    bucket: 'private-dps', endpoint: 'https://private.invalid', region: 'auto',
    accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret',
  })
  vi.stubEnv('DPS_ARCHIVE_REGION', 'ams')
  expect(archiveConfig()?.region).toBe('ams')
})
