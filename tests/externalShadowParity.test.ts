import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertExternalShadowParity } from '../scripts/external-shadow-parity.ts'

test('external shadow parity accepts an exact on-disk handoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-external-parity-'))
  const publicDir = join(root, 'public')
  await mkdir(join(publicDir, 'nested'), { recursive: true })
  await writeFile(join(root, 'reference.json'), '{"same":true}\n')
  await writeFile(join(root, 'candidate.json'), '{"same":true}\n')
  await writeFile(join(publicDir, 'manifest.json'), '{"artifact":"manifest"}')
  await writeFile(join(publicDir, 'nested', 'scope.json'), '{"artifact":"scope"}')

  await assertExternalShadowParity({
    expectedSnapshot: join(root, 'reference.json'),
    actualSnapshot: join(root, 'candidate.json'),
    expectedPublicDir: publicDir,
    actualPublicWrites: [
      { relativePath: 'nested/scope.json', contents: '{"artifact":"scope"}' },
      { relativePath: 'manifest.json', contents: '{"artifact":"manifest"}' },
    ],
  })
})

test('external shadow parity fails closed for interruption or content mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-external-parity-failure-'))
  const publicDir = join(root, 'public')
  await mkdir(publicDir, { recursive: true })
  await writeFile(join(root, 'reference.json'), '{"same":true}\n')
  await writeFile(join(root, 'candidate.json'), '{"same":true}\n')
  await writeFile(join(publicDir, 'manifest.json'), '{"artifact":"reference"}')

  await assert.rejects(assertExternalShadowParity({
    expectedSnapshot: join(root, 'reference.json'),
    actualSnapshot: join(root, 'candidate.json'),
    expectedPublicDir: publicDir,
    actualPublicWrites: [],
  }), /path mismatch/)
  await assert.rejects(assertExternalShadowParity({
    expectedSnapshot: join(root, 'reference.json'),
    actualSnapshot: join(root, 'candidate.json'),
    expectedPublicDir: publicDir,
    actualPublicWrites: [{ relativePath: 'manifest.json', contents: '{"artifact":"candidate"}' }],
  }), /Public artifact mismatch/)
})
