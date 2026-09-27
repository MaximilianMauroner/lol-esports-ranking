import type { SnapshotCheckpointOption } from '../lib/publicArtifacts/schema'
import { rankingScopePeriod } from '../lib/rankingScopeLabel'
import { formatDate } from '../lib/display'
import { Segmented, type SegmentedOption } from './ui'
import { Select } from './ui/select'

export type PendingCheckpoint = { id: string; label: string }

const FULL_YEAR = 'full-year'

/**
 * Season and split scope, as one row plus one sentence.
 *
 * The season is a select because years are switched rarely. The full year and
 * the splits are one segmented control, so exactly one segment is filled and
 * that fill is the selection. The previous track marked "Full year" with a
 * small text button and drew a progress bar under the ongoing split, which
 * read as the selected tab while the full year was active.
 *
 * The sentence under the controls repeats the selection in words, with the
 * date of the latest rated match and the publication date.
 */
export function ScopeBar({
  seasons,
  activeSeason,
  checkpoints,
  activeCheckpoint,
  pendingCheckpoint,
  throughDate,
  scopeThroughDate,
  publishedAt,
  onSelectSeason,
  onSelectCheckpoint,
  onIntent,
}: {
  seasons: string[]
  activeSeason?: string
  checkpoints: SnapshotCheckpointOption[]
  activeCheckpoint?: string
  pendingCheckpoint?: PendingCheckpoint
  /** Latest rated match overall, used for the ongoing split's progress. */
  throughDate?: string
  /** Latest rated match inside the selected scope. */
  scopeThroughDate?: string
  publishedAt?: string
  onSelectSeason: (season: string) => void
  onSelectCheckpoint: (checkpointId: string | undefined) => void
  onIntent?: (checkpointId: string | undefined) => void
}) {
  const showSplits = Boolean(activeSeason && activeSeason !== 'All' && checkpoints.length > 0)
  const active = checkpoints.find((entry) => entry.id === activeCheckpoint)
  const options: SegmentedOption<string>[] = [
    { value: FULL_YEAR, label: 'Full year', title: rankingScopePeriod(activeSeason) },
    ...checkpoints.map((checkpoint) => {
      const progress = checkpoint.ongoing ? checkpointProgress(checkpoint, throughDate) : undefined
      return {
        value: checkpoint.id,
        label: checkpoint.label,
        title: `${formatDate(checkpoint.startDate)} to ${formatDate(checkpoint.endDate)}${progress === undefined ? '' : `. Ongoing: results cover ${progress}% of the split's dates.`}`,
        marker: checkpoint.ongoing ? <LiveMarker /> : undefined,
      }
    }),
    ...(pendingCheckpoint ? [{ value: pendingCheckpoint.id, label: pendingCheckpoint.label, title: `${pendingCheckpoint.label} has not started yet.`, disabled: true }] : []),
  ]
  const selection = !activeSeason || activeSeason === 'All'
    ? 'all seasons'
    : active ? `${activeSeason}, ${active.label}` : `${activeSeason}, full year`

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--line)] bg-[color-mix(in_oklch,var(--surface)_76%,var(--bg))] px-[var(--page-x)] py-2.5"
      role="group"
      aria-label="Ranking period"
    >
      <label className="sr-only" htmlFor="scope-season">Season</label>
      <Select
        id="scope-season"
        className="min-w-[104px] font-mono font-bold text-[var(--text-strong)]"
        value={activeSeason ?? 'All'}
        onChange={(event) => onSelectSeason(event.target.value)}
      >
        {seasons.map((season) => (
          <option key={season} value={season}>
            {season === 'All' ? 'All seasons' : season}
          </option>
        ))}
      </Select>

      {showSplits ? (
        <Segmented
          value={activeCheckpoint ?? FULL_YEAR}
          options={options}
          onChange={(value) => onSelectCheckpoint(value === FULL_YEAR ? undefined : value)}
          onIntent={onIntent ? (value) => onIntent(value === FULL_YEAR ? undefined : value) : undefined}
          ariaLabel={`${activeSeason} period`}
          className="max-sm:basis-full"
        />
      ) : null}

      <p className="text-xs text-[var(--muted)] max-md:basis-full" aria-live="polite">
        Showing <b className="font-semibold text-[var(--text-strong)]">{selection}</b>
        {scopeThroughDate ? <> · results through <b className="font-semibold text-[var(--text)]">{formatDate(scopeThroughDate)}</b></> : null}
        {publishedAt ? <span className="max-sm:hidden"> · updated {formatDate(publishedAt)}</span> : null}
      </p>
    </div>
  )
}

function LiveMarker() {
  return (
    <span className="inline-flex items-center gap-1 text-2xs font-semibold text-[var(--up)]">
      <span className="size-1.5 rounded-full bg-[var(--up)]" aria-hidden="true" />
      <span className="max-sm:sr-only">live</span>
    </span>
  )
}

/**
 * How far through an ongoing split the published data reaches, as a percentage
 * clamped to 0-100. Returns undefined when the dates cannot support an honest
 * answer, so the caller leaves the progress out.
 */
function checkpointProgress(checkpoint: SnapshotCheckpointOption, throughDate?: string) {
  if (!throughDate) return undefined
  const start = Date.parse(checkpoint.startDate)
  const end = Date.parse(checkpoint.endDate)
  const through = Date.parse(throughDate)
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(through)) return undefined
  if (end <= start) return undefined
  return Math.max(0, Math.min(100, Math.round(((through - start) / (end - start)) * 100)))
}
