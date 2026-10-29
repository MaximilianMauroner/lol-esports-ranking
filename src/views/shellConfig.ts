import { BarChart3, CalendarDays, Globe2, History, Radar, Users } from 'lucide-react'
import { type AppMode } from '../browser/bootstrap'
import { type PageLayout } from '../components/ui/loading'

export type Mode = AppMode

export const MODES: { id: Mode; label: string; icon: typeof BarChart3 }[] = [
  { id: 'rankings', label: 'Rankings', icon: BarChart3 },
  { id: 'players', label: 'Players', icon: Users },
  { id: 'profiles', label: 'Profiles', icon: Radar },
  { id: 'regions', label: 'Regions', icon: Globe2 },
  { id: 'matches', label: 'Matches', icon: History },
  { id: 'tournaments', label: 'Tournaments', icon: CalendarDays },
]

/** One title per view and one short line that says what the numbers are. */
/** The skeleton each view shows while its data loads. */
export const PAGE_LAYOUTS: Record<Mode, PageLayout> = { rankings: 'board', players: 'board', profiles: 'board', regions: 'regions', matches: 'ledger', tournaments: 'schedule' }

export const MODE_TITLES: Record<Mode, { title: string; intro: string }> = {
  profiles: {
    title: 'Style profiles',
    intro: 'Observed measures, not strength scores.',
  },
  rankings: {
    title: 'Team Power Index',
    intro: 'Match results weighted by opponent and event. Higher is stronger.',
  },
  players: {
    title: 'Player rankings',
    intro: 'Stats Power ranks role stats against the role average, weighted by event and league strength. Higher is stronger.',
  },
  regions: {
    title: 'Region power',
    intro: 'Average Power of each region\u2019s top three teams.',
  },
  matches: {
    title: 'Match history',
    intro: 'Every rated series, newest first.',
  },
  tournaments: {
    title: 'Tournaments',
    intro: 'Leaguepedia schedule and the Worlds Swiss preview. Not part of the Power Index.',
  },
}
