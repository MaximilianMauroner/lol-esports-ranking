import type { PublicArtifactWrite, PublicArtifactWritePlan } from '../publicArtifacts/writePlan.ts'
import { sha256Hex } from './hash.ts'
import type { IncrementalFallbackReason } from './types.ts'

export type ArtifactDagNodeKind = 'scope' | 'player-entity' | 'team-entity' | 'history-shard' | 'catalog' | 'page' | 'index' | 'manifest'

export type ArtifactDagNode = {
  id: string
  kind: ArtifactDagNodeKind
  semanticHash: string
  envelopeHash: string
  semanticClosureHash: string
  envelopeClosureHash: string
  payload: unknown
  validate: PublicArtifactWrite['validate']
  deps: string[]
  write: PublicArtifactWrite
}

export type PersistedArtifactNode = Omit<ArtifactDagNode, 'payload' | 'validate' | 'write'>

export type ArtifactDag = {
  nodes: ArtifactDagNode[]
  cache: PersistedArtifactNode[]
  writes: PublicArtifactWrite[]
  semanticReused: number
  envelopeReused: number
  regenerated: number
}

export type ArtifactDagBuildResult =
  | { dag: ArtifactDag; fallback?: undefined }
  | { dag?: undefined; fallback: IncrementalFallbackReason }

export function buildPublicArtifactDag({
  actual,
  semantic,
  previous = [],
}: {
  actual: PublicArtifactWritePlan
  semantic: PublicArtifactWritePlan
  previous?: PersistedArtifactNode[]
}): ArtifactDagBuildResult {
  try {
    const actualByPath = uniqueWrites(actual.writes, 'actual')
    const semanticByPath = uniqueWrites(semantic.writes, 'semantic')
    const previousById = uniquePrevious(previous)
    const nodes = [...actualByPath].map(([path, write]): Omit<ArtifactDagNode, 'semanticClosureHash' | 'envelopeClosureHash'> => {
      const semanticWrite = semanticByPath.get(path)
      if (!semanticWrite) throw new ArtifactDagError('missing', `semantic:${path}`)
      const id = artifactNodeId(path)
      return {
        id,
        kind: artifactNodeKind(path, write),
        semanticHash: sha256Hex(semanticWrite.contents),
        envelopeHash: sha256Hex(write.contents),
        payload: semanticWrite.value,
        validate: write.validate,
        deps: artifactDependencies(path, actualByPath),
        write,
      }
    })
    const orderedBase = topologicalOrder(nodes)
    const semanticClosures = new Map<string, string>()
    const envelopeClosures = new Map<string, string>()
    const ordered: ArtifactDagNode[] = orderedBase.map((node) => {
      const semanticClosureHash = closureHash(node.semanticHash, node.deps, semanticClosures)
      const envelopeClosureHash = closureHash(node.envelopeHash, node.deps, envelopeClosures)
      semanticClosures.set(node.id, semanticClosureHash)
      envelopeClosures.set(node.id, envelopeClosureHash)
      return { ...node, semanticClosureHash, envelopeClosureHash }
    })
    const semanticReused = ordered.filter((node) => previousById.get(node.id)?.semanticClosureHash === node.semanticClosureHash).length
    const envelopeReused = ordered.filter((node) => previousById.get(node.id)?.envelopeClosureHash === node.envelopeClosureHash).length
    const writes = ordered
      .filter((node) => previousById.get(node.id)?.envelopeClosureHash !== node.envelopeClosureHash)
      .map((node) => node.write)
    return {
      dag: {
        nodes: ordered,
        cache: ordered.map(({ id, kind, semanticHash, envelopeHash, semanticClosureHash, envelopeClosureHash, deps }) => ({
          id,
          kind,
          semanticHash,
          envelopeHash,
          semanticClosureHash,
          envelopeClosureHash,
          deps,
        })),
        writes,
        semanticReused,
        envelopeReused,
        regenerated: writes.length,
      },
    }
  } catch (error) {
    const detail = error instanceof ArtifactDagError ? `${error.reason}:${error.nodeId}` : 'unknown'
    return { fallback: { kind: 'dependency-unknown', dependency: `artifact-dag:${detail}` } }
  }
}

export function validatePersistedArtifactNodes(nodes: PersistedArtifactNode[]) {
  const ids = new Set<string>()
  for (const node of nodes) {
    if (!node.id || ids.has(node.id)) throw new ArtifactDagError('duplicate', node.id)
    ids.add(node.id)
    if (!isNodeKind(node.kind)
      || !node.semanticHash
      || !node.envelopeHash
      || !node.semanticClosureHash
      || !node.envelopeClosureHash
      || !Array.isArray(node.deps)) {
      throw new ArtifactDagError('invalid', node.id)
    }
  }
  for (const node of nodes) for (const dep of node.deps) if (!ids.has(dep)) throw new ArtifactDagError('missing', dep)
  const ordered = topologicalOrder(nodes)
  const semanticClosures = new Map<string, string>()
  const envelopeClosures = new Map<string, string>()
  for (const node of ordered) {
    const semanticClosureHash = closureHash(node.semanticHash, node.deps, semanticClosures)
    const envelopeClosureHash = closureHash(node.envelopeHash, node.deps, envelopeClosures)
    if (node.semanticClosureHash !== semanticClosureHash || node.envelopeClosureHash !== envelopeClosureHash) {
      throw new ArtifactDagError('invalid', `closure:${node.id}`)
    }
    semanticClosures.set(node.id, semanticClosureHash)
    envelopeClosures.set(node.id, envelopeClosureHash)
  }
}

function uniqueWrites(writes: PublicArtifactWrite[], label: string) {
  const byPath = new Map<string, PublicArtifactWrite>()
  for (const write of writes) {
    if (byPath.has(write.relativePath)) throw new ArtifactDagError('duplicate', `${label}:${write.relativePath}`)
    byPath.set(write.relativePath, write)
  }
  return byPath
}

function uniquePrevious(nodes: PersistedArtifactNode[]) {
  validatePersistedArtifactNodes(nodes)
  return new Map(nodes.map((node) => [node.id, node]))
}

function artifactNodeId(path: string) {
  return `public:${path}`
}

function artifactNodeKind(path: string, write: PublicArtifactWrite): ArtifactDagNodeKind {
  if (write.family === 'manifest') return 'manifest'
  if (write.family === 'scope') return 'scope'
  if (path === 'entities/players.json') return 'player-entity'
  if (path === 'entities/teams.json') return 'team-entity'
  if (path.includes('/pages/')) return 'page'
  if (path.endsWith('/index.json') || path === 'matches/index.json') return 'index'
  if (path.startsWith('matches/')) return 'catalog'
  return 'history-shard'
}

function artifactDependencies(path: string, writes: Map<string, PublicArtifactWrite>) {
  const paths = [...writes.keys()]
  if (path === 'ranking-summary.json') return paths.filter((candidate) => candidate !== path).map(artifactNodeId).sort()
  if (path === 'matches/index.json') return paths.filter((candidate) => candidate.startsWith('matches/') && candidate !== path && !candidate.includes('/pages/')).map(artifactNodeId).sort()
  if (path.startsWith('matches/') && !path.includes('/pages/') && path !== 'matches/index.json') {
    const stem = path.split('/').at(-1)?.replace(/\.json$/, '') ?? ''
    return paths.filter((candidate) => candidate.startsWith(`matches/pages/${stem}-`)).map(artifactNodeId).sort()
  }
  if (path.endsWith('/index.json')) {
    const prefix = path.slice(0, -'index.json'.length)
    return paths.filter((candidate) => candidate.startsWith(prefix) && candidate !== path).map(artifactNodeId).sort()
  }
  return []
}

function closureHash(selfHash: string, deps: string[], closures: Map<string, string>) {
  return sha256Hex(JSON.stringify({
    selfHash,
    dependencies: deps.map((dependency) => {
      const hash = closures.get(dependency)
      if (!hash) throw new ArtifactDagError('missing', dependency)
      return [dependency, hash]
    }),
  }))
}

function topologicalOrder<T extends Pick<ArtifactDagNode, 'id' | 'deps'>>(nodes: T[]): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  if (byId.size !== nodes.length) throw new ArtifactDagError('duplicate', 'node-id')
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const ordered: T[] = []
  const visit = (id: string) => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new ArtifactDagError('cycle', id)
    const node = byId.get(id)
    if (!node) throw new ArtifactDagError('missing', id)
    visiting.add(id)
    for (const dep of node.deps) visit(dep)
    visiting.delete(id)
    visited.add(id)
    ordered.push(node)
  }
  for (const node of nodes) visit(node.id)
  return ordered
}

function isNodeKind(value: string): value is ArtifactDagNodeKind {
  return value === 'scope'
    || value === 'player-entity'
    || value === 'team-entity'
    || value === 'history-shard'
    || value === 'catalog'
    || value === 'page'
    || value === 'index'
    || value === 'manifest'
}

class ArtifactDagError extends Error {
  readonly reason: 'duplicate' | 'cycle' | 'missing' | 'invalid'
  readonly nodeId: string

  constructor(reason: ArtifactDagError['reason'], nodeId: string) {
    super(`Artifact DAG ${reason}: ${nodeId}`)
    this.reason = reason
    this.nodeId = nodeId
  }
}
