import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { decodePrivateState, encodePrivateState } from '../src/lib/incremental/canonicalCodec.ts'
import {
  validatePersistedSnapshotModelState,
  type PersistedSnapshotModelState,
} from '../src/lib/incremental/snapshotInputs.ts'

export type StagedShadowModelState = {
  directory: string
  path: string
  digest: string
  bytes: number
}

export function stageShadowModelState(stateDir: string, state: PersistedSnapshotModelState): StagedShadowModelState {
  const shadowRoot = resolve(stateDir, 'shadow')
  mkdirSync(shadowRoot, { recursive: true, mode: 0o700 })
  chmodSync(shadowRoot, 0o700)
  const directory = mkdtempSync(join(shadowRoot, 'snapshot-model-'))
  chmodSync(directory, 0o700)
  const path = join(directory, 'state.json')
  const temporaryPath = join(directory, `.state-${randomUUID()}.tmp`)
  try {
    const contents = Buffer.from(encodePrivateState(state))
    writeFileSync(temporaryPath, contents, { flag: 'wx', mode: 0o600 })
    renameSync(temporaryPath, path)
    chmodSync(path, 0o600)
    return {
      directory,
      path,
      digest: createHash('sha256').update(contents).digest('hex'),
      bytes: contents.byteLength,
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

export function readStagedShadowModelState(
  staged: StagedShadowModelState,
  compatibilityHash: string,
): PersistedSnapshotModelState {
  const file = statSync(staged.path)
  if (!file.isFile() || file.size !== staged.bytes) throw new Error('Shadow model state byte length mismatch')
  const contents = readFileSync(staged.path)
  if (contents.byteLength !== staged.bytes) throw new Error('Shadow model state byte length mismatch')
  const digest = createHash('sha256').update(contents).digest('hex')
  if (digest !== staged.digest) throw new Error('Shadow model state digest mismatch')
  const state = decodePrivateState(contents.toString('utf8')) as PersistedSnapshotModelState
  validatePersistedSnapshotModelState(state, compatibilityHash)
  return state
}

export function cleanupStagedShadowModelState(staged: StagedShadowModelState | undefined): void {
  if (staged) rmSync(staged.directory, { recursive: true, force: true })
}
