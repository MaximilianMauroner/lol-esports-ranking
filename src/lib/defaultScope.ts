export function currentSeasonScope(now = new Date()) {
  return `season:${now.getUTCFullYear()}`
}

export function preferredPublicSnapshotKey(
  snapshotKeys: readonly string[],
  defaultSnapshotKey: string | undefined,
  now = new Date(),
) {
  const currentSeasonKey = `${now.getUTCFullYear()}__All__All`
  if (snapshotKeys.includes(currentSeasonKey)) return currentSeasonKey
  return defaultSnapshotKey
}
