export function mapArtifactReferences(
  content: Record<string, unknown>,
  transform: (reference: string, role: 'required' | 'audit') => string,
): Record<string, unknown>
export function artifactReferences(content: Record<string, unknown>): string[]
export function normalizeLogicalArtifactUrl(value: string): string
