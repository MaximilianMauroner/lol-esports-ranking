import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const roots = new Set([
  '.agents', '.github', '.gitignore', 'AGENTS.md', 'README.md', 'LICENSE',
  'components.json', 'index.html', 'eslint.config.js', 'vite.config.ts',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'tsconfig.test.json',
  'Dockerfile.refresh', 'Dockerfile.refresh.dockerignore', 'railway.toml', 'railway.refresh.toml',
  'src', 'scripts', 'tools', 'tests', 'worker', 'ops', 'data', 'public', 'docs',
])
export function trackedPathError(path) {
  if (!roots.has(path.split('/')[0])) return 'Unapproved tracked root'
  if (path.startsWith('.agents/') && !path.startsWith('.agents/skills/')) return 'Agent output must stay ignored'
  if (/(?:^|\/)(?:node_modules|dist|coverage|\.cache|\.vite|test-results|playwright-report)(?:\/|$)/.test(path)) return 'Generated output must stay ignored'
  if (/^(?:public\/(?:data|tournament-data)|data\/(?:derived|reference)|worker\/target)(?:\/|$)/.test(path)) return 'Generated output must stay ignored'
  if (path.startsWith('data/') && path !== 'data/raw/manifest.json') return 'Local data must stay ignored'
  if (/\.(?:md|html?)$/i.test(path)
    && /(?:^|[/_.-])(?:reports?|plans?|audits?|handoffs?|captures?|reviews?|research)(?:[/_.-]|$)/i.test(path)
  ) return 'Narrative output must stay in ignored agent artifacts'
}

export function checkLayout(root = process.cwd()) {
  let files
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    if (resolve(top) !== resolve(root)) return { blocked: true, errors: ['BLOCKED: tracked-file hygiene requires Git metadata at the source root'] }
    files = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean)
  } catch {
    return { blocked: true, errors: ['BLOCKED: tracked-file hygiene requires Git metadata'] }
  }
  return { blocked: false, errors: files.flatMap(path => {
    const error = trackedPathError(path)
    return error ? [`${path}: ${error}`] : []
  }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkLayout(process.argv[2])
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = result.blocked ? 2 : 1 }
  else console.log('Tracked source and output hygiene passed')
}
