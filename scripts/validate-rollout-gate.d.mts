export function readRolloutGateReceipt(
  value: unknown,
  options?: Record<string, unknown>,
): Promise<(Record<string, unknown> & { value: Record<string, unknown>; sha256: string }) | undefined>

export function validateRolloutGate(options?: {
  intervalMinutes?: number
  mode?: string
  commit?: string
  deploymentId?: string
  receipt?: unknown
  now?: string | number | Date
}): Promise<{ allowed: boolean; affected: boolean; criteria: Record<string, boolean>; [key: string]: unknown }>
