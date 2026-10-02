export const ARCHIVE_FORMAT_VERSION: 1
export const ARCHIVE_PAGE_BYTES: number
export const ARCHIVE_MAX_DEPTH: number
export type ArchiveReference = { sha256: string; bytes: number; encoding: 'gzip'; count: number; startUtcDate?: string; endUtcDate?: string; year?: string; path?: string; keyStart?: string; keyEnd?: string }
export function isPublicArchive(value: unknown): boolean
export function createArchive(content: Record<string, unknown>, store: (value: Record<string, unknown>) => Omit<ArchiveReference, 'count'>): Record<string, unknown>
export function archiveReferences(content: unknown): ArchiveReference[]
export function hydrateArchive(content: unknown, load: (reference: ArchiveReference) => Promise<unknown>, options?: { years?: string[]; records?: Record<string, string[]>; onReference?: (reference: ArchiveReference) => void }): Promise<unknown>
export type ArchiveSelection = { years?: string[]; records?: Record<string, string[]> }
export function projectArchiveView(content: unknown, selection?: ArchiveSelection): unknown
