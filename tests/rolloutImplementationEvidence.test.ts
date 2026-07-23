import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { canonicalJsonFor } from '../scripts/public-artifact-storage.mjs'
import {
  IMPLEMENTATION_EVIDENCE_CONTRACTS,
  IMPLEMENTATION_EVIDENCE_REQUIREMENTS,
  generateImplementationEvidence,
  parseImplementationEvidence,
  resolveImplementationAuthority,
  writeImplementationAuthority,
} from '../scripts/rollout-implementation-evidence.mjs'
import {
  createImplementationRepositoryFixture,
  generateNativeImplementationEvidence,
  generatePassingImplementationEvidence,
  passingImplementationCommand,
} from './implementationEvidenceTestFixtures.ts'

const exec = promisify(execFile)

test('native implementation evidence generation is deterministic, exact, and commit-bound', async () => {
  const fixture = await createImplementationRepositoryFixture()
  try {
    const first = await generatePassingImplementationEvidence(fixture.root, fixture.commit)
    const second = await generatePassingImplementationEvidence(fixture.root, fixture.commit)
    assert.deepEqual(first, second)
    assert.deepEqual(first.map((value) => value.requirementId), IMPLEMENTATION_EVIDENCE_REQUIREMENTS)
    for (const value of first) {
      assert.equal(parseImplementationEvidence(value), value)
      assert.equal(value.evidenceClass, 'repository-implementation')
      assert.equal(value.subjectCommit, fixture.commit)
      assert.equal(value.producerSourceCommit, fixture.commit)
      assert.equal(value.result, 'proved')
      assert.deepEqual(value.assertions.map((entry) => entry.id), IMPLEMENTATION_EVIDENCE_CONTRACTS[value.requirementId].assertionIds)
      assert.equal(Object.hasOwn(value, 'recordedAt'), false)
      assert.equal(Object.hasOwn(value, 'deploymentId'), false)
      assert.equal(JSON.stringify(value).includes(fixture.root), false)
    }
  } finally {
    await fixture.cleanup()
  }
})

test('generation rejects modified or uncommitted contract sources and arbitrary command claims', async () => {
  const fixture = await createImplementationRepositoryFixture()
  try {
    const values = await generateNativeImplementationEvidence(fixture.root, fixture.commit)
    const forged = structuredClone(values[0])
    forged.commands[0].argv = ['node', '--test', 'tests/invented.test.ts']
    assert.throws(() => parseImplementationEvidence(forged), /contract/)
    assert.throws(() => parseImplementationEvidence({ ...values[0], invented: true }), /unexpected or missing keys/)
    assert.throws(() => parseImplementationEvidence({ ...values[0], contractId: 'invented-v1' }), /contract/)
    const modifiedPath = join(fixture.root, values[0].sourceDigests[0].path)
    const original = await readFile(modifiedPath)
    await writeFile(modifiedPath, 'modified\n')
    await assert.rejects(generatePassingImplementationEvidence(fixture.root, fixture.commit), /clean|not committed/)
    await writeFile(modifiedPath, original)
    await assert.rejects(
      generateImplementationEvidence({
        repositoryRoot: fixture.root,
        subjectCommit: '0'.repeat(40),
        runCommand: passingImplementationCommand,
      }),
      /checked-out producer source commit/,
    )
  } finally {
    await fixture.cleanup()
  }
})

test('local authority is canonical, create-only, reusable, and rejects conflicting manifests', async () => {
  const fixture = await createImplementationRepositoryFixture()
  const authority = join(fixture.root, '.rollout-evidence')
  try {
    const values = await generateNativeImplementationEvidence(fixture.root, fixture.commit)
    const manifest = await writeImplementationAuthority(values, { authorityDir: authority, repositoryRoot: fixture.root })
    assert.deepEqual(await writeImplementationAuthority(values, { authorityDir: authority, repositoryRoot: fixture.root }), manifest)
    const bytes = await readFile(join(authority, 'subjects', fixture.commit, 'manifest.json'), 'utf8')
    assert.equal(bytes, canonicalJsonFor(manifest))
    assert.equal((await resolveImplementationAuthority({
      authorityDir: authority,
      subjectCommit: fixture.commit,
      repositoryRoot: fixture.root,
    })).length, IMPLEMENTATION_EVIDENCE_REQUIREMENTS.length)
    const sourcePath = join(fixture.root, values[0].sourceDigests[0].path)
    const sourceBytes = await readFile(sourcePath)
    await writeFile(sourcePath, Buffer.concat([sourceBytes, Buffer.from('\n')]))
    await assert.rejects(resolveImplementationAuthority({
      authorityDir: authority,
      subjectCommit: fixture.commit,
      repositoryRoot: fixture.root,
    }), /clean|source digest mismatch/)
    await writeFile(sourcePath, sourceBytes)
    const contradicted = structuredClone(values)
    contradicted[0].commands[0].exitCode = 1
    contradicted[0].assertions[0].passed = false
    contradicted[0].result = 'contradicted'
    const withoutRunId = Object.fromEntries(Object.entries(contradicted[0]).filter(([key]) => key !== 'runId'))
    const { createHash } = await import('node:crypto')
    contradicted[0].runId = `repository-${contradicted[0].requirementId}-${createHash('sha256').update(canonicalJsonFor(withoutRunId)).digest('hex').slice(0, 16)}`
    assert.equal(parseImplementationEvidence(contradicted[0]), contradicted[0])
    await assert.rejects(writeImplementationAuthority(contradicted, { authorityDir: authority, repositoryRoot: fixture.root }), /Conflicting immutable/)
  } finally {
    await fixture.cleanup()
  }
})

test('resolution rejects fake-runner proof, dirty worktrees, and evidence from an older HEAD', async () => {
  const fixture = await createImplementationRepositoryFixture()
  const authority = join(fixture.root, '.rollout-evidence')
  try {
    const fake = await generatePassingImplementationEvidence(fixture.root, fixture.commit)
    await writeImplementationAuthority(fake, { authorityDir: authority, repositoryRoot: fixture.root })
    await assert.rejects(resolveImplementationAuthority({
      authorityDir: authority,
      subjectCommit: fixture.commit,
      repositoryRoot: fixture.root,
    }), /independently rerun native outcome/)

    await writeFile(join(fixture.root, 'untracked-proof-bypass.txt'), 'bypass\n')
    await assert.rejects(resolveImplementationAuthority({
      authorityDir: authority,
      subjectCommit: fixture.commit,
      repositoryRoot: fixture.root,
    }), /clean tracked and untracked/)
    await unlink(join(fixture.root, 'untracked-proof-bypass.txt'))

    await writeFile(join(fixture.root, 'later.txt'), 'later\n')
    await exec('git', ['add', 'later.txt'], { cwd: fixture.root })
    await exec('git', ['-c', 'user.name=Evidence Test', '-c', 'user.email=evidence@example.invalid', 'commit', '-qm', 'later'], { cwd: fixture.root })
    await assert.rejects(resolveImplementationAuthority({
      authorityDir: authority,
      subjectCommit: fixture.commit,
      repositoryRoot: fixture.root,
    }), /subject must equal repository HEAD/)
  } finally {
    await fixture.cleanup()
  }
})

test('local authority rejects relative roots, symlinks, noncanonical JSON, and digest mismatches', async () => {
  const fixture = await createImplementationRepositoryFixture()
  const authority = join(fixture.root, '.rollout-evidence')
  try {
    const values = await generatePassingImplementationEvidence(fixture.root, fixture.commit)
    const manifest = await writeImplementationAuthority(values, { authorityDir: authority, repositoryRoot: fixture.root })
    const manifestEvidence = (manifest as { evidence: Array<{ sha256: string }> }).evidence
    await assert.rejects(writeImplementationAuthority(values, {
      authorityDir: '.rollout-evidence',
      repositoryRoot: fixture.root,
    }), /explicit absolute path/)
    await assert.rejects(writeImplementationAuthority(values, {
      authorityDir: `${fixture.root}/nested/../.rollout-evidence`,
      repositoryRoot: fixture.root,
    }), /traversal/)
    await assert.rejects(writeImplementationAuthority(values, {
      authorityDir: join(resolve(fixture.root, '..'), '.rollout-evidence'),
      repositoryRoot: fixture.root,
    }), /repository \.rollout-evidence child/)
    const linkedRoot = `${fixture.root}-link`
    await symlink(fixture.root, linkedRoot, 'dir')
    await assert.rejects(resolveImplementationAuthority({
      authorityDir: join(linkedRoot, '.rollout-evidence'),
      subjectCommit: fixture.commit,
      repositoryRoot: linkedRoot,
    }), /unsymlinked/)
    await unlink(linkedRoot)

    const firstObject = join(authority, 'objects', 'sha256', manifestEvidence[0].sha256)
    const original = await readFile(firstObject)
    await unlink(firstObject)
    await symlink(join(authority, 'subjects', fixture.commit, 'manifest.json'), firstObject)
    await assert.rejects(resolveImplementationAuthority({
      authorityDir: authority,
      subjectCommit: fixture.commit,
      repositoryRoot: fixture.root,
    }), /symlink/)

    await unlink(firstObject)
    await mkdir(firstObject)
    await assert.rejects(resolveImplementationAuthority({
      authorityDir: authority,
      subjectCommit: fixture.commit,
      repositoryRoot: fixture.root,
    }), /regular file/)
    await rm(firstObject, { recursive: true })
    await writeFile(firstObject, original)
    const manifestPath = join(authority, 'subjects', fixture.commit, 'manifest.json')
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await assert.rejects(resolveImplementationAuthority({
      authorityDir: authority,
      subjectCommit: fixture.commit,
      repositoryRoot: fixture.root,
    }), /not canonical/)

    await writeFile(manifestPath, canonicalJsonFor(manifest))
    const parsed = JSON.parse(original.toString('utf8'))
    parsed.result = 'contradicted'
    await writeFile(firstObject, canonicalJsonFor(parsed))
    await assert.rejects(resolveImplementationAuthority({
      authorityDir: authority,
      subjectCommit: fixture.commit,
      repositoryRoot: fixture.root,
    }), /digest mismatch/)
    assert.equal((await lstat(authority)).isSymbolicLink(), false)
  } finally {
    await fixture.cleanup()
  }
})

test('descriptor-relative create cannot be redirected by an ancestor swap', async () => {
  const fixture = await createImplementationRepositoryFixture()
  const authority = join(fixture.root, '.rollout-evidence')
  const external = `${fixture.root}-external`
  try {
    await mkdir(external)
    const values = await generatePassingImplementationEvidence(fixture.root, fixture.commit)
    let swapped = false
    await assert.rejects(writeImplementationAuthority(values, {
      authorityDir: authority,
      repositoryRoot: fixture.root,
      ioHook: async ({ phase, relativePath }: { phase: string; relativePath: string }) => {
        if (swapped || phase !== 'before-create' || !relativePath.startsWith('objects/sha256/')) return
        swapped = true
        const original = join(authority, 'objects', 'sha256')
        await rename(original, join(external, 'sha256'))
        await symlink(external, original, 'dir')
      },
    }), /ELOOP|ENOTDIR|symbolic link|descriptor/)
    assert.equal(swapped, true)
    assert.deepEqual(await readdir(external), ['sha256'])
    assert.deepEqual(await readdir(join(external, 'sha256')), [])
  } finally {
    await fixture.cleanup()
    await rm(external, { recursive: true, force: true })
  }
})
