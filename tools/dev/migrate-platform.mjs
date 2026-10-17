import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const moves = JSON.parse(readFileSync(resolve(root, 'tools/dev/platform-migration-map.json'), 'utf8'))
const map = new Map(moves.map(move => [move.old, move]))
const extensions = ['', '.ts', '.tsx', '.mjs', '.d.mts', '.js']
const slash = path => path.replaceAll('\\', '/')
const domain = path => path.match(/^src\/domains\/([^/]+)\//)?.[1]
const localPath = (file, target, extension = true) => {
  let result = slash(relative(dirname(file), target))
  if (!extension) result = result.replace(/\.tsx?$/, '')
  return result.startsWith('.') ? result : `./${result}`
}
function sources(directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? sources(path) : /\.(?:[cm]?[jt]sx?|json|ya?ml)$/.test(path) ? [path] : []
  })
}
function targetFor(file, specifier, isImport) {
  const base = specifier.startsWith('.') ? slash(relative(root, resolve(root, dirname(file), specifier)))
    : specifier.startsWith('@/') ? `src/${specifier.slice(2)}` : specifier.replace(/^\//, '')
  const move = extensions.map(extension => map.get(base + extension)).find(Boolean)
  if (!move) return
  const caller = map.get(file)?.new ?? file
  const internal = domain(caller) && domain(caller) === domain(move.new)
  const test = caller.startsWith('tests/')
  const target = isImport && move.entry && !internal && !test ? move.entry : move.new
  return specifier.startsWith('.') ? localPath(caller, target, /\.[cm]?[jt]sx?$/.test(specifier))
    : specifier.startsWith('@/') ? `@/${target.slice(4).replace(/\.tsx?$/, '')}`
      : `${specifier.startsWith('/') ? '/' : ''}${target}`
}

const apply = process.argv.includes('--apply')
const files = ['src', 'scripts', 'tools', 'tests', '.github'].flatMap(sources)
files.push(...['vite.config.ts', 'eslint.config.js', 'tsconfig.app.json', 'tsconfig.node.json', 'package.json'].filter(file => existsSync(resolve(root, file))))
const pending = []
const entries = new Map()
for (const move of moves) {
  if (move.entry && move.entry !== move.new) {
    const list = entries.get(move.entry) ?? []
    list.push(move.new)
    entries.set(move.entry, list)
  }
}
for (const file of files) {
  if (file === 'tools/dev/platform-migration-map.json' || file === 'tools/dev/migrate-platform.mjs') continue
  const text = readFileSync(resolve(root, file), 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const edits = []
  const visit = node => {
    if (ts.isStringLiteralLike(node)) {
      const parent = node.parent
      if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'baselineModule') return
      const isImport = ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)
        || (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword)
        || ts.isLiteralTypeNode(parent)
      let next = targetFor(file, node.text, isImport)
      if (!next && map.has(file) && node.text.startsWith('.') && isImport) {
        const target = slash(relative(root, resolve(root, dirname(file), node.text)))
        if (extensions.some(extension => existsSync(resolve(root, target + extension)))) next = localPath(map.get(file).new, target)
      }
      if (next && next !== node.text) edits.push([node.getStart(source) + 1, node.getEnd() - 1, next])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  let next = text
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) next = next.slice(0, start) + value + next.slice(end)
  if (next !== text) { pending.push(file); if (apply) writeFileSync(resolve(root, file), next) }
}
for (const move of moves) {
  if (!existsSync(resolve(root, move.old))) continue
  if (existsSync(resolve(root, move.new))) throw new Error(`Both migration paths exist: ${move.old}, ${move.new}`)
  pending.push(`${move.old} -> ${move.new}`)
  if (apply) { mkdirSync(dirname(resolve(root, move.new)), { recursive: true }); renameSync(resolve(root, move.old), resolve(root, move.new)) }
}
for (const [entry, modules] of entries) {
  if (existsSync(resolve(root, entry))) continue
  pending.push(entry)
  if (apply) {
    mkdirSync(dirname(resolve(root, entry)), { recursive: true })
    writeFileSync(resolve(root, entry), modules.map(module => `export * from '${localPath(entry, module, false)}'`).join('\n') + '\n')
  }
}
if (pending.length) {
  console.log(pending.join('\n'))
  if (!apply && !process.argv.includes('--dry-run')) process.exitCode = 1
} else console.log('Platform migration is complete')
