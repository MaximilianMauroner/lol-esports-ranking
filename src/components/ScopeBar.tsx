import type { SnapshotCheckpointOption } from '../lib/publicArtifacts/schema'
import { formatDate } from '../lib/display'
import { Button } from './ui/button'
import { Select } from './ui/select'

export type PendingCheckpoint = { id: string; label: string }

/**
 * Season and split scope, as one row.
 *
 * This replaced two rows of tabs, up to eight controls, sitting between the
 * page title and the data on every view. Two changes carry it:
 *
 * 1. The season is a select, not tabs. Years are switched rarely, so they do
 *    not earn permanent horizontal space.
 * 2. The splits are one continuous track rather than separate pills. Position
 *    already carries the ordering, so each segment needs a label, not a box.
 *    The track can then show where the season actually is, which a row of tabs
 *    cannot: the ongoing split fills in proportion to how far through it is.
 *
 * `throughDate` is the latest rated match date, not the wall clock, so the
 * progress a reader sees matches the data the page is built from.
 */
export function ScopeBar({
  seasons,
  activeSeason,
  checkpoints,
  activeCheckpoint,
  pendingCheckpoint,
  throughDate,
  onSelectSeason,
  onSelectCheckpoint,
  onIntent,
}: {
  seasons: string[]
  activeSeason?: string
  checkpoints: SnapshotCheckpointOption[]
  activeCheckpoint?: string
  pendingCheckpoint?: PendingCheckpoint
  throughDate?: string
  onSelectSeason: (season: string) => void
  onSelectCheckpoint: (checkpointId: string | undefined) => void
  onIntent?: (checkpointId: string | undefined) => void
}) {
  const showTrack = Boolean(activeSeason && activeSeason !== 'All' && checkpoints.length > 0)
  const seasonRange = showTrack ? seasonRangeLabel(checkpoints) : undefined

  return (
    // Both groups are a label line over a control at --control-h, and the row
    // aligns them from the top. Centring a bare select against the whole track
    // block put it half a line above the split buttons it belongs beside.
    <div
      className="flex flex-wrap items-start gap-x-5 gap-y-2 border-b border-[var(--line)] bg-[color-mix(in_oklch,var(--surface)_76%,var(--bg))] px-[var(--page-x)] py-2.5"
      aria-label="Snapshot scope controls"
    >
      <div className="shrink-0">
        <label className="mb-1 flex h-4 items-center text-2xs leading-none text-[var(--faint)]" htmlFor="scope-season">Season</label>
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
      </div>

      {showTrack ? (
        <>
          {/* Capped, because a track stretched across a 1440px page turns four
              splits into four billboards. */}
          <div className="min-w-0 max-w-[720px] flex-1 max-[720px]:max-w-none max-[720px]:basis-full">
            <div className="mb-1 flex h-4 items-center justify-between gap-3 text-2xs leading-none text-[var(--faint)]">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-pressed={!activeCheckpoint}
                className="-ml-1 h-4 px-1 py-0 text-2xs leading-none aria-pressed:text-[var(--accent-strong)]"
                onClick={() => onSelectCheckpoint(undefined)}
                onPointerEnter={() => onIntent?.(undefined)}
                onFocus={() => onIntent?.(undefined)}
              >
                Full year
              </Button>
              {seasonRange ? <span className="truncate">{seasonRange}</span> : null}
            </div>
            <div
              className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto [overscroll-behavior-x:contain] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              role="group"
              aria-label={`${activeSeason} splits`}
            >
              {checkpoints.map((checkpoint) => {
                const active = activeCheckpoint === checkpoint.id
                const progress = checkpoint.ongoing ? checkpointProgress(checkpoint, throughDate) : undefined
                return (
                  <Button
                    key={checkpoint.id}
                    type="button"
                    variant="tab"
                    size="default"
                    aria-pressed={active}
                    title={checkpoint.description}
                    className="relative h-[var(--control-h)] min-w-[92px] flex-1 flex-col items-start justify-center gap-0 overflow-hidden rounded-[var(--r-2)] px-2.5 py-0"
                    onClick={() => onSelectCheckpoint(checkpoint.id)}
                    onPointerEnter={() => onIntent?.(checkpoint.id)}
                    onFocus={() => onIntent?.(checkpoint.id)}
                  >
                    <span className="text-sm font-semibold leading-[1.2]">{checkpoint.label}</span>
                    <span className="text-2xs font-normal leading-[1.15] text-[var(--muted)]">
                      {progress === undefined ? `to ${formatDate(checkpoint.endDate)}` : `${progress}% through`}
                    </span>
                    {progress === undefined ? null : (
                      <>
                        <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--line)]" aria-hidden="true" />
                        <span className="absolute bottom-0 left-0 h-[2px] bg-[var(--accent)]" style={{ width: `${progress}%` }} aria-hidden="true" />
                      </>
                    )}
                  </Button>
                )
              })}
              {pendingCheckpoint ? (
                <div
                  className="grid h-[var(--control-h)] min-w-[92px] flex-1 cursor-default content-center rounded-[var(--r-2)] border border-dashed border-[var(--line)] px-2.5 text-[var(--faint)]"
                  aria-disabled="true"
                  title={`${pendingCheckpoint.label} has not started yet.`}
                >
                  <span className="text-sm font-semibold leading-[1.2]">{pendingCheckpoint.label}</span>
                  <span className="text-2xs leading-[1.15]">Not started</span>
                </div>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

function seasonRangeLabel(checkpoints: SnapshotCheckpointOption[]) {
  const first = checkpoints[0]
  const last = checkpoints.at(-1)
  if (!first || !last) return undefined
  return `${formatDate(first.startDate)} to ${formatDate(last.endDate)}`
}

/**
 * How far through an ongoing split the published data reaches, as a percentage
 * clamped to 0-100. Returns undefined when the dates cannot support an honest
 * answer, so the caller falls back to showing the end date.
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
