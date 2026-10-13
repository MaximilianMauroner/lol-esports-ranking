import type { PublicSemanticArtifact } from './artifactIdentity'

const MAX_BYTES = 8 * 1024 * 1024
const MAX_ENTRIES = 128
type Entry = { bytes: number; request: Promise<PublicSemanticArtifact> }

/** Cache verified immutable JSON, before applying a caller's archive selection. */
export class SemanticArtifactCache {
  private entries = new Map<string, Entry>()
  private bytes = 0

  load(key: string, bytes: number, load: (signal?: AbortSignal) => Promise<PublicSemanticArtifact>, signal?: AbortSignal) {
    // Preserve fetch's abort behavior without starting a background request.
    if (signal?.aborted || bytes > MAX_BYTES) return load(signal)
    let entry = this.entries.get(key)
    if (entry) {
      this.entries.delete(key)
      this.entries.set(key, entry)
    } else {
      while (this.entries.size >= MAX_ENTRIES || this.bytes + bytes > MAX_BYTES) {
        const oldest = this.entries.keys().next().value
        if (oldest === undefined) break
        this.remove(oldest)
      }
      // One navigation must not cancel an immutable request another view needs.
      const request = load(AbortSignal.timeout(20_000))
      entry = { bytes, request }
      this.entries.set(key, entry)
      this.bytes += bytes
      void request.catch(() => {
        if (this.entries.get(key)?.request === request) this.remove(key)
      })
    }
    return waitForRequest(entry.request, signal)
  }

  private remove(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.bytes -= entry.bytes
    this.entries.delete(key)
  }
}

function waitForRequest<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    void request.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
