import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { verifyReferencePublicData } from '../scripts/reference-public-data.mjs'

export async function retainedOriginCorpus(directory: string) {
  assert.ok(isAbsolute(directory), 'The retained corpus must be an explicit absolute directory')
  await verifyReferencePublicData(directory)
  const files: { path: string; bytes: number; sha256: string }[] = []
  async function visit(relative: string) {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(path)
      else {
        assert.ok(entry.isFile() && path.endsWith('.json'), 'Only retained JSON files are allowed')
        const body = await readFile(join(directory, path))
        files.push({ path, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') })
      }
    }
  }
  await visit('')
  assert.equal(files.length, 299)
  assert.equal(files.reduce((sum, file) => sum + file.bytes, 0), 32_724_167)
  assert.equal(Math.max(...files.map(file => file.bytes)), 3_070_942)
  const rootFile = files.find(file => file.path === 'ranking-summary.json')
  assert.equal(rootFile?.sha256, '115712b21735fb0c44787c98c69364328642625b52b055af45e82fd7586f14d8')
  const root = JSON.parse(await readFile(join(directory, 'ranking-summary.json'), 'utf8'))
  assert.equal(root.source, "Oracle's Elixir primary with Leaguepedia Cargo gap-fill")
  assert.equal(root.dataMode, 'scheduled-public-data')
  assert.equal(root.model.version, 'transparent-power-index-v0.2.0')
  assert.equal(root.model.configHash, 'fnv1a-5eebb6ce')
  return { provenance: 'retained-public-content', publicationAuthority: 'not supplied',
    aggregateSha256: '873eb6c5d35b1f43f83e9f248bd53090be9c99932a13bef5079396c18075fc0c',
    rootSha256: rootFile!.sha256, files: files.sort((left, right) => left.path.localeCompare(right.path)),
    fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    largest: files.reduce((largest, file) => file.bytes > largest.bytes ? file : largest),
    generatedAt: root.generatedAt, schemaVersion: root.schemaVersion, source: root.source, dataMode: root.dataMode,
    model: { version: root.model.version, configHash: root.model.configHash } }
}
