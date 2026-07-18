export type RegionalSplitCalendar = {
  starts: readonly [string, string, string]
  seasonEnd: string
}

// Global split windows begin when the first tier-one region starts that split.
// Keep announced calendars explicit so schedule changes cannot rewrite history.
export const regionalSplitCalendars: Readonly<Record<string, RegionalSplitCalendar>> = {
  '2026': {
    starts: ['2026-01-14', '2026-03-28', '2026-07-22'],
    seasonEnd: '2026-11-14',
  },
}
