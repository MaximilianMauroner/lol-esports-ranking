export const referencePublicDir: string
export const referencePublicDataDir: string
export function ensureReferencePublicData(): Promise<string>
export function verifyReferencePublicData(directory: string): Promise<void>
