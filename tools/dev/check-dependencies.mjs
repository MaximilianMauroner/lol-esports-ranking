import { readdirSync, existsSync, realpathSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { builtinModules } from 'node:module'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { ownerOf, browserGlobals, isProducer, pureOwners, domainImportError } from './ownership-policy.mjs'

const sourceExtension = /\.(?:[cm]?[jt]sx?)$/
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))

function sourceFiles(root, directory) {
  const base = resolve(root, directory)
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? sourceFiles(root, path) : sourceExtension.test(path) ? [resolve(root, path)] : []
  })
}

function typeOnly(node) {
  if (ts.isImportTypeNode(node)) return true
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause
    return Boolean(clause && (clause.isTypeOnly || (!clause.name && clause.namedBindings
      && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length
      && clause.namedBindings.elements.every(element => element.isTypeOnly))))
  }
  return Boolean(ts.isExportDeclaration(node) && (node.isTypeOnly || (node.exportClause
    && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length
    && node.exportClause.elements.every(element => element.isTypeOnly))))
}

function importReference(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
    return { literal: node.moduleSpecifier, type: typeOnly(node) }
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
    return { literal: node.argument.literal, type: true }
  }
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
    return { literal: node.arguments[0], type: false }
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
    && node.arguments?.length === 2 && ts.isStringLiteralLike(node.arguments[0])
    && ts.isPropertyAccessExpression(node.arguments[1]) && node.arguments[1].name.text === 'url'
    && ts.isMetaProperty(node.arguments[1].expression)
    && node.arguments[1].expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
    return { literal: node.arguments[0], type: false, url: true }
  }
}

function unwrap(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression
  return node
}

function referenceIdentifier(node) {
  const parent = node.parent
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node)
    || (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node))
    || ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)
      || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)) && parent.name === node)
    || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)
    || ts.isNamespaceImport(parent) || ts.isLabeledStatement(parent)) return false
  return true
}

function checkGlobals(source, checker, report) {
  const aliases = new Set()
  const declarations = []
  const isGlobal = node => {
    const symbol = checker.getSymbolAtLocation(node)
    return !symbol?.declarations?.some(declaration => !declaration.getSourceFile().isDeclarationFile)
  }
  const isRuntime = node => {
    node = unwrap(node)
    return ts.isIdentifier(node) && ((node.text === 'globalThis' && isGlobal(node)) || aliases.has(checker.getSymbolAtLocation(node)))
  }
  const collect = node => {
    if (ts.isVariableDeclaration(node) && node.initializer) declarations.push([node.name, node.initializer])
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) declarations.push([node.left, node.right])
    ts.forEachChild(node, collect)
  }
  collect(source)
  let changed = true
  while (changed) {
    changed = false
    for (const [name, initializer] of declarations) {
      if (!ts.isIdentifier(name) || !isRuntime(initializer)) continue
      const symbol = checker.getSymbolAtLocation(name)
      if (symbol && !aliases.has(symbol)) { aliases.add(symbol); changed = true }
    }
  }
  const visit = node => {
    if (ts.isIdentifier(node) && browserGlobals.has(node.text) && referenceIdentifier(node) && isGlobal(node)) report(node, `Shared source uses browser global ${node.text}`)
    if (ts.isPropertyAccessExpression(node) && isRuntime(node.expression) && browserGlobals.has(node.name.text)) report(node, `Shared source reads browser global ${node.name.text}`)
    if (ts.isElementAccessExpression(node) && isRuntime(node.expression) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) && browserGlobals.has(node.argumentExpression.text)) report(node, `Shared source reads browser global ${node.argumentExpression.text}`)
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isRuntime(node.initializer)) {
      for (const element of node.name.elements) {
        const name = element.propertyName ?? element.name
        if ((ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && browserGlobals.has(name.text)) report(element, `Shared source reads browser global ${name.text}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

export function checkDependencies(root = process.cwd()) {
  root = realpathSync(resolve(root))
  const files = ['src', 'scripts', 'tools', 'tests'].flatMap(directory => sourceFiles(root, directory))
  if (existsSync(resolve(root, 'vite.config.ts'))) files.push(resolve(root, 'vite.config.ts'))
  const configPath = resolve(root, 'tsconfig.app.json')
  const config = existsSync(configPath) ? ts.readConfigFile(configPath, ts.sys.readFile).config : {}
  const options = ts.parseJsonConfigFileContent(config, ts.sys, root).options
  Object.assign(options, { allowJs: true, noEmit: true, skipLibCheck: true, moduleResolution: ts.ModuleResolutionKind.Bundler })
  const program = ts.createProgram(files, options)
  const checker = program.getTypeChecker()
  const errors = []
  const edges = new Map()
  for (const path of files) {
    const source = program.getSourceFile(path)
    if (!source) continue
    const file = relative(root, path).replaceAll('\\', '/')
    const owner = ownerOf(file)
    if (file.endsWith('.d.mts') && !existsSync(path.replace(/\.d\.mts$/, '.mjs'))) errors.push(`${file}: Declaration requires its mjs implementation`)
    if (!owner) { errors.push(`${file}: Source has no owner`); continue }
    const report = (node, message) => errors.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${message}`)
    const runtimeEdges = []
    const visit = node => {
      if (owner.name !== 'tools' && owner.name !== 'tests' && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && !ts.isStringLiteralLike(node.arguments[0])) report(node, 'Dynamic source imports require a literal target')
      const entry = importReference(node)
      if (entry) {
        const specifier = entry.literal.text
        const modulePath = specifier.startsWith('.') ? resolve(dirname(path), specifier)
          : specifier.startsWith('/src/') ? resolve(root, specifier.slice(1)) : specifier
        const resolved = ts.resolveModuleName(modulePath, path, options, ts.sys).resolvedModule
        let resolvedPath = resolved?.resolvedFileName
        if (!entry.type && resolvedPath && /\.d\.[cm]?ts$/.test(resolvedPath)) {
          const implementation = resolvedPath.replace(/\.d\.mts$/, '.mjs').replace(/\.d\.cts$/, '.cjs').replace(/\.d\.ts$/, '.js')
          if (existsSync(implementation)) resolvedPath = implementation
        }
        if (resolvedPath && existsSync(resolvedPath)) resolvedPath = realpathSync(resolvedPath)
        const local = resolvedPath && !resolved.isExternalLibraryImport ? relative(root, resolvedPath).replaceAll('\\', '/') : undefined
        if (local?.startsWith('../')) report(node, `Source import escapes the source root: ${specifier}`)
        const target = local && ownerOf(local)
        if (target) {
          if (!owner.imports.includes(target.name)) report(node, `${owner.name} cannot import ${target.name} source ${local}`)
          const boundary = domainImportError(file, local)
          if (boundary) report(node, boundary)
          if (!entry.type) runtimeEdges.push(local)
        } else if (specifier.startsWith('.') || specifier.startsWith('@/') || specifier.startsWith('/src/')) {
          if (sourceExtension.test(specifier) || (!entry.url && !/\.[a-z0-9]+(?:\?|$)/i.test(specifier))) report(node, `Unresolved source import ${specifier}`)
        } else if ((pureOwners.has(owner.name) || owner.name === 'browser') && (builtins.has(specifier) || specifier.startsWith('node:'))) {
          report(node, `${owner.name} cannot import Node builtin ${specifier}`)
        } else if (owner.name !== 'browser' && owner.name !== 'tests' && /^(react|react-dom)(\/|$)/.test(specifier)) {
          report(node, `${owner.name} cannot import React`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    edges.set(file, runtimeEdges)
    if (pureOwners.has(owner.name) && !source.isDeclarationFile) checkGlobals(source, checker, report)
  }
  for (const [file] of edges) {
    if (ownerOf(file)?.name !== 'browser') continue
    const seen = new Set()
    const visit = (path, chain) => {
      if (seen.has(path)) return
      seen.add(path)
      if (isProducer(path)) { errors.push(`${file}: Browser runtime reaches producer ${chain.join(' -> ')}`); return }
      for (const next of edges.get(path) ?? []) visit(next, [...chain, next])
    }
    visit(file, [file])
  }
  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = checkDependencies(process.argv[2])
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log('Source ownership passed without Git metadata')
}
