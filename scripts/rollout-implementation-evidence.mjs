import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdir, open, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalJsonFor } from './public-artifact-storage.mjs'

export const IMPLEMENTATION_EVIDENCE_KIND = 'ranking-rollout-implementation-test-evidence'
export const IMPLEMENTATION_EVIDENCE_CLASS = 'repository-implementation'
export const IMPLEMENTATION_EVIDENCE_REQUIREMENTS = Object.freeze([
  'provider-request-retry',
  'complete-immutable-receipts',
])

export const IMPLEMENTATION_EVIDENCE_CONTRACTS = Object.freeze({
  'provider-request-retry': Object.freeze({
    contractId: 'provider-request-retry-v1',
    sourcePaths: Object.freeze([
      'scripts/rollout-implementation-evidence.mjs',
      'scripts/rollout-implementation-evidence.d.mts',
      'scripts/audit-plan-completion.mjs',
      'scripts/audit-plan-completion.d.mts',
      'scripts/provider-fetch-retry.mjs',
      'scripts/provider-fetch-retry.d.mts',
      'scripts/download-local-data.mjs',
      'scripts/fetch-leaguepedia.mjs',
      'scripts/fetch-lolesports-schedule.mjs',
      'scripts/fetch-riot-gpr-snapshot.mjs',
      'scripts/lolesports-schedule-probe.mjs',
      'tests/providerFetchRetry.test.ts',
      'tests/providerFetchCallSites.test.ts',
    ]),
    commands: Object.freeze([
      Object.freeze({
        id: 'provider-retry-native-tests',
        argv: Object.freeze(['node', '--import', 'tsx', '--test', '--test-reporter=tap', 'tests/providerFetchRetry.test.ts']),
      }),
      Object.freeze({
        id: 'provider-retry-call-site-tests',
        argv: Object.freeze(['node', '--import', 'tsx', '--test', '--test-reporter=tap', 'tests/providerFetchCallSites.test.ts']),
      }),
    ]),
    assertionIds: Object.freeze([
      'provider-retry-native-tests',
      'provider-retry-call-site-tests',
    ]),
  }),
  'complete-immutable-receipts': Object.freeze({
    contractId: 'complete-immutable-receipts-v1',
    sourcePaths: Object.freeze([
      'scripts/rollout-implementation-evidence.mjs',
      'scripts/rollout-implementation-evidence.d.mts',
      'scripts/audit-plan-completion.mjs',
      'scripts/audit-plan-completion.d.mts',
      'scripts/refresh-once.mjs',
      'scripts/refresh-once.d.mts',
      'scripts/rollout-evidence.mjs',
      'scripts/rollout-evidence.d.mts',
      'tests/refreshOnceEarlyReceipts.test.ts',
    ]),
    commands: Object.freeze([
      Object.freeze({
        id: 'refresh-early-terminal-receipt-tests',
        argv: Object.freeze(['node', '--import', 'tsx', '--test', '--test-reporter=tap', 'tests/refreshOnceEarlyReceipts.test.ts']),
      }),
    ]),
    assertionIds: Object.freeze(['refresh-early-terminal-receipt-tests']),
  }),
})

const EVIDENCE_KEYS = Object.freeze([
  'artifactKind',
  'schemaVersion',
  'evidenceClass',
  'requirementId',
  'contractId',
  'subjectCommit',
  'producerSourceCommit',
  'runId',
  'sourceDigests',
  'commands',
  'assertions',
  'result',
])
const SOURCE_DIGEST_KEYS = Object.freeze(['path', 'sha256'])
const COMMAND_KEYS = Object.freeze(['id', 'argv', 'exitCode', 'passed', 'failed', 'cancelled'])
const ASSERTION_KEYS = Object.freeze(['id', 'passed'])
const MANIFEST_KEYS = Object.freeze(['artifactKind', 'schemaVersion', 'subjectCommit', 'evidence'])
const MANIFEST_ENTRY_KEYS = Object.freeze(['requirementId', 'sha256'])

export async function generateImplementationEvidence({
  repositoryRoot,
  subjectCommit,
  runCommand = runNativeCommand,
} = {}) {
  const root = requiredAbsoluteDirectory(repositoryRoot, 'repository root')
  assertCommit(subjectCommit, 'subject commit')
  const currentCommit = await readCurrentCommit(root)
  if (currentCommit !== subjectCommit) throw new Error('Implementation evidence subject commit must equal the checked-out producer source commit')
  await assertContractSourcesCommitted(root, subjectCommit)
  const values = []
  for (const requirementId of IMPLEMENTATION_EVIDENCE_REQUIREMENTS) {
    const contract = IMPLEMENTATION_EVIDENCE_CONTRACTS[requirementId]
    const sourceDigests = await digestContractSources(root, contract)
    const commands = []
    for (const command of contract.commands) {
      const result = await runCommand(command.argv, { cwd: root })
      commands.push(parseCommandResult({ id: command.id, argv: [...command.argv], ...result }))
    }
    const assertions = contract.assertionIds.map((id) => {
      const command = commands.find((entry) => entry.id === id)
      return {
        id,
        passed: Boolean(command && command.exitCode === 0 && command.passed > 0
          && command.failed === 0 && command.cancelled === 0),
      }
    })
    const result = commands.every(commandPassed) && assertions.every((entry) => entry.passed)
      ? 'proved'
      : 'contradicted'
    const withoutRunId = {
      artifactKind: IMPLEMENTATION_EVIDENCE_KIND,
      schemaVersion: 1,
      evidenceClass: IMPLEMENTATION_EVIDENCE_CLASS,
      requirementId,
      contractId: contract.contractId,
      subjectCommit,
      producerSourceCommit: subjectCommit,
      sourceDigests,
      commands,
      assertions,
      result,
    }
    const runId = `repository-${requirementId}-${sha256(canonicalJsonFor(withoutRunId)).slice(0, 16)}`
    values.push(parseImplementationEvidence({ ...withoutRunId, runId }))
  }
  return values
}

export function parseImplementationEvidence(value) {
  assertRecord(value, 'implementation evidence')
  assertExactKeys(value, EVIDENCE_KEYS, 'implementation evidence')
  if (value.artifactKind !== IMPLEMENTATION_EVIDENCE_KIND || value.schemaVersion !== 1
    || value.evidenceClass !== IMPLEMENTATION_EVIDENCE_CLASS) {
    throw new Error('Invalid implementation evidence identity')
  }
  if (!IMPLEMENTATION_EVIDENCE_REQUIREMENTS.includes(value.requirementId)) {
    throw new Error('Invalid implementation evidence requirement')
  }
  const contract = IMPLEMENTATION_EVIDENCE_CONTRACTS[value.requirementId]
  if (value.contractId !== contract.contractId) throw new Error('Invalid implementation evidence contract')
  assertCommit(value.subjectCommit, 'subjectCommit')
  assertCommit(value.producerSourceCommit, 'producerSourceCommit')
  if (value.subjectCommit !== value.producerSourceCommit) throw new Error('Implementation evidence producer commit mismatch')
  if (!Array.isArray(value.sourceDigests) || value.sourceDigests.length !== contract.sourcePaths.length) {
    throw new Error('Invalid implementation evidence source digests')
  }
  value.sourceDigests.forEach((entry, index) => {
    assertRecord(entry, `sourceDigests[${index}]`)
    assertExactKeys(entry, SOURCE_DIGEST_KEYS, `sourceDigests[${index}]`)
    if (entry.path !== contract.sourcePaths[index] || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid implementation evidence sourceDigests[${index}]`)
    }
  })
  if (!Array.isArray(value.commands) || value.commands.length !== contract.commands.length) {
    throw new Error('Invalid implementation evidence commands')
  }
  value.commands.forEach((entry, index) => {
    assertRecord(entry, `commands[${index}]`)
    assertExactKeys(entry, COMMAND_KEYS, `commands[${index}]`)
    const expected = contract.commands[index]
    if (entry.id !== expected.id || !equalStrings(entry.argv, expected.argv)) {
      throw new Error(`Invalid implementation evidence commands[${index}] contract`)
    }
    for (const field of ['exitCode', 'passed', 'failed', 'cancelled']) {
      if (!Number.isSafeInteger(entry[field]) || entry[field] < 0) {
        throw new Error(`Invalid implementation evidence commands[${index}].${field}`)
      }
    }
  })
  if (!Array.isArray(value.assertions) || value.assertions.length !== contract.assertionIds.length) {
    throw new Error('Invalid implementation evidence assertions')
  }
  value.assertions.forEach((entry, index) => {
    assertRecord(entry, `assertions[${index}]`)
    assertExactKeys(entry, ASSERTION_KEYS, `assertions[${index}]`)
    if (entry.id !== contract.assertionIds[index] || typeof entry.passed !== 'boolean') {
      throw new Error(`Invalid implementation evidence assertions[${index}]`)
    }
    const command = value.commands.find((candidate) => candidate.id === entry.id)
    const expectedPassed = Boolean(command && commandPassed(command))
    if (entry.passed !== expectedPassed) throw new Error(`Implementation evidence assertion ${entry.id} is inconsistent`)
  })
  const proved = value.commands.every(commandPassed) && value.assertions.every((entry) => entry.passed)
  if (value.result !== (proved ? 'proved' : 'contradicted')) throw new Error('Implementation evidence result is inconsistent')
  const withoutRunId = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'runId'))
  const expectedRunId = `repository-${value.requirementId}-${sha256(canonicalJsonFor(withoutRunId)).slice(0, 16)}`
  if (value.runId !== expectedRunId) throw new Error('Implementation evidence runId is not deterministic')
  return value
}

export async function verifyImplementationEvidenceSources(value, { repositoryRoot } = {}) {
  const evidence = parseImplementationEvidence(value)
  const root = requiredAbsoluteDirectory(repositoryRoot, 'repository root')
  const contract = IMPLEMENTATION_EVIDENCE_CONTRACTS[evidence.requirementId]
  const current = await digestContractSources(root, contract)
  if (canonicalJsonFor(current) !== canonicalJsonFor(evidence.sourceDigests)) {
    throw new Error(`Implementation evidence source digest mismatch for ${evidence.requirementId}`)
  }
  return evidence
}

export async function writeImplementationAuthority(values, { authorityDir } = {}) {
  const root = await prepareAuthorityRoot(authorityDir)
  const parsed = values.map(parseImplementationEvidence)
  if (parsed.length !== IMPLEMENTATION_EVIDENCE_REQUIREMENTS.length
    || !IMPLEMENTATION_EVIDENCE_REQUIREMENTS.every((id) => parsed.some((value) => value.requirementId === id))) {
    throw new Error('Implementation authority requires exactly one evidence object per fixed requirement')
  }
  const subjectCommit = parsed[0].subjectCommit
  if (!parsed.every((value) => value.subjectCommit === subjectCommit)) throw new Error('Implementation authority subject commits differ')
  const evidence = []
  for (const value of parsed) {
    const bytes = canonicalBytes(value)
    const digest = sha256(bytes)
    await createOnlyCanonicalFile(root, `objects/sha256/${digest}`, bytes)
    evidence.push({ requirementId: value.requirementId, sha256: digest })
  }
  evidence.sort((left, right) => IMPLEMENTATION_EVIDENCE_REQUIREMENTS.indexOf(left.requirementId)
    - IMPLEMENTATION_EVIDENCE_REQUIREMENTS.indexOf(right.requirementId))
  const manifest = parseImplementationManifest({
    artifactKind: 'ranking-rollout-implementation-evidence-manifest',
    schemaVersion: 1,
    subjectCommit,
    evidence,
  })
  await createOnlyCanonicalFile(root, `subjects/${subjectCommit}/manifest.json`, canonicalBytes(manifest))
  return manifest
}

export async function resolveImplementationAuthority({
  authorityDir,
  subjectCommit,
  repositoryRoot,
} = {}) {
  const root = await inspectAuthorityRoot(authorityDir)
  assertCommit(subjectCommit, 'subject commit')
  const manifest = parseImplementationManifest(await readCanonicalJsonFile(root, `subjects/${subjectCommit}/manifest.json`))
  if (manifest.subjectCommit !== subjectCommit) throw new Error('Implementation authority subject mismatch')
  const values = []
  for (const entry of manifest.evidence) {
    const bytes = await readContainedRegularFile(root, `objects/sha256/${entry.sha256}`)
    if (sha256(bytes) !== entry.sha256) throw new Error('Implementation authority object digest mismatch')
    const canonical = canonicalBytes(JSON.parse(bytes.toString('utf8')))
    if (!bytes.equals(canonical)) throw new Error('Implementation authority object is not canonical JSON')
    const value = await verifyImplementationEvidenceSources(JSON.parse(bytes.toString('utf8')), { repositoryRoot })
    if (value.subjectCommit !== subjectCommit || value.requirementId !== entry.requirementId) {
      throw new Error('Implementation authority object metadata mismatch')
    }
    values.push(value)
  }
  return values
}

export function parseImplementationManifest(value) {
  assertRecord(value, 'implementation evidence manifest')
  assertExactKeys(value, MANIFEST_KEYS, 'implementation evidence manifest')
  if (value.artifactKind !== 'ranking-rollout-implementation-evidence-manifest' || value.schemaVersion !== 1) {
    throw new Error('Invalid implementation evidence manifest identity')
  }
  assertCommit(value.subjectCommit, 'manifest subjectCommit')
  if (!Array.isArray(value.evidence) || value.evidence.length !== IMPLEMENTATION_EVIDENCE_REQUIREMENTS.length) {
    throw new Error('Invalid implementation evidence manifest entries')
  }
  value.evidence.forEach((entry, index) => {
    assertRecord(entry, `manifest evidence[${index}]`)
    assertExactKeys(entry, MANIFEST_ENTRY_KEYS, `manifest evidence[${index}]`)
    if (entry.requirementId !== IMPLEMENTATION_EVIDENCE_REQUIREMENTS[index] || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid implementation evidence manifest entry ${index}`)
    }
  })
  return value
}

async function digestContractSources(root, contract) {
  const digests = []
  for (const sourcePath of contract.sourcePaths) {
    assertSafeRelativePath(sourcePath)
    const bytes = await readContainedRegularFile(root, sourcePath)
    digests.push({ path: sourcePath, sha256: sha256(bytes) })
  }
  return digests
}

async function runNativeCommand(argv, { cwd }) {
  const [command, ...args] = argv
  return new Promise((resolveRun) => {
    const child = spawn(command === 'node' ? process.execPath : command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', (error) => {
      resolveRun({ exitCode: 1, passed: 0, failed: 1, cancelled: 0, error: error.message })
    })
    child.on('close', (code) => {
      resolveRun({
        exitCode: Number.isSafeInteger(code) && code >= 0 ? code : 1,
        passed: tapCount(output, 'pass'),
        failed: tapCount(output, 'fail'),
        cancelled: tapCount(output, 'cancelled'),
      })
    })
  })
}

function tapCount(output, name) {
  const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))]
  return Number(matches.at(-1)?.[1] ?? 0)
}

function parseCommandResult(value) {
  return {
    id: value.id,
    argv: value.argv,
    exitCode: nonNegativeInteger(value.exitCode),
    passed: nonNegativeInteger(value.passed),
    failed: nonNegativeInteger(value.failed),
    cancelled: nonNegativeInteger(value.cancelled),
  }
}

function commandPassed(value) {
  return value.exitCode === 0 && value.passed > 0 && value.failed === 0 && value.cancelled === 0
}

async function readCurrentCommit(root) {
  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', rejectRun)
    child.on('close', (code) => code === 0 ? resolveRun(stdout.trim()) : rejectRun(new Error(stderr.trim())))
  })
  assertCommit(result, 'checked-out commit')
  return result
}

async function assertContractSourcesCommitted(root, subjectCommit) {
  const paths = [...new Set(IMPLEMENTATION_EVIDENCE_REQUIREMENTS.flatMap(
    (requirementId) => IMPLEMENTATION_EVIDENCE_CONTRACTS[requirementId].sourcePaths,
  ))]
  for (const sourcePath of paths) {
    const committed = await readGitObject(root, `${subjectCommit}:${sourcePath}`)
    const current = await readContainedRegularFile(root, sourcePath)
    if (!committed.equals(current)) {
      throw new Error(`Implementation evidence source is not committed at ${subjectCommit}: ${sourcePath}`)
    }
  }
}

async function readGitObject(root, objectName) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('git', ['show', objectName], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', rejectRun)
    child.on('close', (code) => code === 0
      ? resolveRun(Buffer.concat(chunks))
      : rejectRun(new Error(`Unable to read committed implementation source: ${stderr.trim()}`)))
  })
}

async function prepareAuthorityRoot(authorityDir) {
  const root = requiredAbsoluteDirectory(authorityDir, 'implementation authority directory')
  await mkdir(root, { recursive: true })
  return inspectAuthorityRoot(root)
}

async function inspectAuthorityRoot(authorityDir) {
  const root = requiredAbsoluteDirectory(authorityDir, 'implementation authority directory')
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Implementation authority root must be a real directory')
  return root
}

async function createOnlyCanonicalFile(root, relativePath, bytes) {
  assertSafeRelativePath(relativePath)
  const target = containedPath(root, relativePath)
  await ensureContainedDirectories(root, dirname(target))
  try {
    const handle = await open(target, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
    } finally {
      await handle.close()
    }
    return 'created'
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = await readContainedRegularFile(root, relativePath)
    if (!existing.equals(bytes)) {
      throw new Error(`Conflicting immutable implementation authority file: ${relativePath}`, { cause: error })
    }
    return 'reused'
  }
}

async function ensureContainedDirectories(root, targetDirectory) {
  const relativeDirectory = relative(root, targetDirectory)
  assertSafeRelativePath(relativeDirectory)
  let current = root
  for (const part of relativeDirectory.split(sep).filter(Boolean)) {
    current = resolve(current, part)
    try {
      const stat = await lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Implementation authority path contains a non-directory or symlink')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await mkdir(current)
    }
  }
}

async function readCanonicalJsonFile(root, relativePath) {
  const bytes = await readContainedRegularFile(root, relativePath)
  const value = JSON.parse(bytes.toString('utf8'))
  if (!bytes.equals(canonicalBytes(value))) throw new Error('Implementation authority JSON is not canonical')
  return value
}

async function readContainedRegularFile(root, relativePath) {
  assertSafeRelativePath(relativePath)
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Implementation authority/source root must be a real directory')
  const target = containedPath(root, relativePath)
  const relativeParts = relativePath.split(/[\\/]/)
  let current = root
  for (const part of relativeParts) {
    current = resolve(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new Error('Implementation authority/source path contains a symlink')
  }
  const stat = await lstat(target)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Implementation authority/source object must be a regular file')
  return readFile(target)
}

function containedPath(root, relativePath) {
  const target = resolve(root, relativePath)
  const fromRoot = relative(root, target)
  if (fromRoot === '' || fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || isAbsolute(fromRoot)) {
    throw new Error('Implementation authority/source path escapes its root')
  }
  return target
}

function assertSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)
    || value.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Implementation authority/source path must be a safe relative path')
  }
}

function requiredAbsoluteDirectory(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an explicit absolute path`)
  if (value.split(/[\\/]/).includes('..')) throw new Error(`${label} must not contain traversal segments`)
  const directory = resolve(value)
  if (label === 'implementation authority directory' && basename(directory) !== '.rollout-evidence') {
    throw new Error('implementation authority directory must be an explicit .rollout-evidence directory')
  }
  return directory
}

function canonicalBytes(value) {
  return Buffer.from(canonicalJsonFor(value), 'utf8')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertCommit(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new Error(`${label} must be a lowercase 40-character Git commit`)
}

function assertRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
}

function assertExactKeys(value, keys, label) {
  if (!equalStrings(Object.keys(value).sort(), [...keys].sort())) throw new Error(`${label} has unexpected or missing keys`)
}

function equalStrings(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index])
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

async function main(args) {
  const options = parseCliArgs(args)
  const values = await generateImplementationEvidence({
    repositoryRoot: options.repositoryRoot,
    subjectCommit: options.subjectCommit,
  })
  const manifest = await writeImplementationAuthority(values, { authorityDir: options.authorityDir })
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
  if (values.some((value) => value.result !== 'proved')) process.exitCode = 1
}

function parseCliArgs(args) {
  if (args[0] === '--') args = args.slice(1)
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!['--subject-commit', '--authority-dir', '--repository-root'].includes(flag) || !value) {
      throw new Error('Usage: rollout-implementation-evidence --subject-commit <commit> --authority-dir <absolute-path> [--repository-root <absolute-path>]')
    }
    values.set(flag, value)
  }
  return {
    subjectCommit: values.get('--subject-commit'),
    authorityDir: requiredAbsoluteDirectory(values.get('--authority-dir'), 'implementation authority directory'),
    repositoryRoot: requiredAbsoluteDirectory(values.get('--repository-root') ?? process.cwd(), 'repository root'),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
