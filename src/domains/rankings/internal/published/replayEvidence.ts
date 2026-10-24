import type { ReplayEvidence } from '../queries/replayEvidence.ts'
import { artifactMetaFor, PUBLIC_ARTIFACT_SCHEMA_VERSION } from './schema.ts'

export function replayEvidenceArtifact(evidence: ReplayEvidence, generatedAt: string) {
  return { ...evidence, schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION, generatedAt,
    artifactMeta: artifactMetaFor({ generatedAt, modelVersion: evidence.model.version, modelConfigHash: evidence.model.configHash }) }
}
