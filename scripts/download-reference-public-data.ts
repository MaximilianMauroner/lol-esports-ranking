import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ensureReferencePublicData } from './reference-public-data.mjs'
import { replaceDirectory } from './replace-directory.ts'

const reference = await ensureReferencePublicData()
await mkdir('public', { recursive: true })
const staging = await mkdtemp(resolve('public', '.data-download-'))
try {
  await cp(reference, staging, { recursive: true })
  await replaceDirectory(staging, resolve('public/data'))
} finally {
  await rm(staging, { recursive: true, force: true })
}
console.log('Reference snapshot downloaded to public/data. For current source data, run pnpm data:download and pnpm data:crunch.')
