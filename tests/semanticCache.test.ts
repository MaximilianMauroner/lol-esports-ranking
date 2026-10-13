import assert from 'node:assert/strict'
import test from 'node:test'
import { SemanticArtifactCache } from '../src/lib/publicArtifacts/semanticCache.ts'
import type { PublicSemanticArtifact } from '../src/lib/publicArtifacts/artifactIdentity.ts'

const artifact: PublicSemanticArtifact = { artifactKind: 'public-semantic-artifact', schemaVersion: 1, content: { artifactKind: 'test' } }

test('a cancelled view does not cancel a shared preload or its next consumer', async () => {
  const cache = new SemanticArtifactCache()
  const controller = new AbortController()
  let complete!: (value: PublicSemanticArtifact) => void
  let requests = 0
  let sharedSignal: AbortSignal | undefined
  const load = (signal?: AbortSignal) => {
    requests += 1
    sharedSignal = signal
    return new Promise<PublicSemanticArtifact>((resolve) => { complete = resolve })
  }
  const cancelled = cache.load('immutable-object', 200, load, controller.signal)
  const navigation = cache.load('immutable-object', 200, load)
  controller.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })
  assert.equal(sharedSignal?.aborted, false)
  complete(artifact)
  assert.equal(await navigation, artifact)
  assert.equal(await cache.load('immutable-object', 200, load), artifact)
  assert.equal(requests, 1)
})

test('failed validation leaves the next request free to retry', async () => {
  const cache = new SemanticArtifactCache()
  let requests = 0
  const load = async () => {
    requests += 1
    if (requests === 1) throw new Error('semantic digest mismatch')
    return artifact
  }
  await assert.rejects(cache.load('immutable-object', 200, load), /semantic digest mismatch/)
  assert.equal(await cache.load('immutable-object', 200, load), artifact)
  assert.equal(requests, 2)
})

test('the byte limit evicts old data and retains recently visited objects', async () => {
  const cache = new SemanticArtifactCache()
  const requests: string[] = []
  const load = (key: string) => cache.load(key, 3 * 1024 * 1024, async () => { requests.push(key); return artifact })
  await load('first')
  await load('second')
  await load('first')
  await load('third')
  await load('first')
  assert.deepEqual(requests, ['first', 'second', 'third'])
  await load('second')
  assert.deepEqual(requests, ['first', 'second', 'third', 'second'])
})

test('the entry limit bounds caches of small archive directory objects', async () => {
  const cache = new SemanticArtifactCache()
  let requests = 0
  const load = async () => { requests += 1; return artifact }
  for (let index = 0; index <= 128; index += 1) await cache.load(String(index), 1, load)
  await cache.load('128', 1, load)
  assert.equal(requests, 129)
  await cache.load('0', 1, load)
  assert.equal(requests, 130)
})
