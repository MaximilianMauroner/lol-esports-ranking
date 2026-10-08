import type { ChildProcess } from 'node:child_process'
import type { Worker } from 'node:worker_threads'
type Span = { id: number; name: string; started: number; cpu: NodeJS.CpuUsage }
type Profile = { worker: Worker; done: Promise<void> }
export const diagnosticsEnabled: boolean
export function diagnosticBegin(name: string, counts?: Record<string, number>): Span | undefined
export function diagnosticEnd(span: Span | undefined, counts?: Record<string, number>): void
export function diagnosticChild(child: ChildProcess): void
export function diagnosticFiles(paths: string[], root: string): void
export function firstDiagnosticRepetition(root: string): boolean
export function diagnosticProfile(kind: 'allocation' | 'cpu', name: 'parent-full' | 'verifier-full' | 'refresh-cpu'): Promise<Profile | undefined>
export function diagnosticStopProfile(profile: Profile | undefined): Promise<void>
